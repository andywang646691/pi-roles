/**
 * Regression tests for the `/role <name> --reset` cross-session handoff.
 *
 * The bug this guards against: pi re-invokes the extension factory for
 * every new session (new ExtensionRunner -> loadExtension -> factory(api)),
 * so anything captured in the factory closure is recreated per session.
 * The "role to apply after reset" handoff was stored in that closure, so it
 * never survived `ctx.newSession()` — every `--reset` silently started the
 * new session with the default `pi` role ("Switched to role pi").
 *
 * These tests simulate pi's runtime shape: the SAME factory function is
 * invoked once per "session", and `newSession` synchronously fires
 * `session_start` (reason="new") on the NEW session's runner. The handoff
 * must survive across the two factory invocations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_ROLE_ENTRY_TYPE } from "../src/schemas.ts";

type SessionStartReason = "startup" | "new" | "reload" | "resume";

interface FakeSession {
  /** The extension API object the factory registered against. */
  pi: ReturnType<typeof makeFakePi>;
  /** Command context handed to the /role command handler. */
  ctx: ReturnType<typeof makeFakeCtx>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  /** Fire session_start exactly like pi's runner does. */
  emitSessionStart: (reason: SessionStartReason) => Promise<void>;
}

interface Shared {
  /** Every `ctx.ui.notify` toast across all fake sessions (display-only). */
  toasts: string[];
  /** Every pi.setSessionName call across all fake sessions. */
  sessionNames: string[];
  /** Every pi.appendEntry call: { customType, data } — stub so tests can assert persistence. */
  appended: { customType: string; data: unknown }[];
  /** Stub so tests can assert notifications never reach the LLM path. */
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeFakePi(shared: Shared) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  return {
    on: (ev: string, fn: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(ev, fn);
    },
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def);
    },
    getFlag: () => undefined,
    getAllTools: () => [],
    setActiveTools: () => {},
    setSessionName: (name: string) => shared.sessionNames.push(name),
    setModel: async () => true,
    setThinkingLevel: () => {},
    appendEntry: (customType: string, data: unknown) => shared.appended.push({ customType, data }),
    // Must never be called: role-switch notifications are display-only
    // toasts, NOT persisted custom messages (those would leak into the LLM
    // context via sessionEntryToContextMessages/convertToLlm).
    sendMessage: shared.sendMessage,
    // test hooks (not part of the ExtensionAPI surface)
    handlers,
    commands,
  };
}

function makeFakeCtx(cwd: string, shared: Shared, entries: unknown[] = []) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => shared.toasts.push(message),
      setStatus: () => {},
    },
    sessionManager: { getEntries: () => entries },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    newSession: undefined as unknown,
    waitForIdle: async () => {},
  };
}

function makeSession(factory: (pi: any) => void, cwd: string, shared: Shared, entries: unknown[] = []): FakeSession {
  const pi = makeFakePi(shared);
  factory(pi); // <-- pi calls the factory once per session/runtime
  const ctx = makeFakeCtx(cwd, shared, entries);
  return {
    pi,
    ctx,
    commands: pi.commands,
    emitSessionStart: async (reason: SessionStartReason) => {
      const fn = pi.handlers.get("session_start");
      if (!fn) throw new Error("no session_start handler registered");
      await fn({ type: "session_start", reason }, ctx);
    },
  };
}

describe("/role <name> --reset cross-session handoff", () => {
  let home: string;
  let cwd: string;
  let originalHome: string | undefined;
  let shared: Shared;

  beforeEach(() => {
    // Isolate role discovery: point HOME at a temp dir with a user-scope
    // `bare` role, so the fake sessions discover exactly what we control.
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "pi-roles-reset-home-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-roles-reset-cwd-"));
    process.env.HOME = home;
    const rolesDir = join(home, ".pi", "agent", "roles");
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(
      join(rolesDir, "bare.md"),
      "---\nname: bare\ndescription: bare test role\n---\nbare body\n",
    );
    shared = { toasts: [], sessionNames: [], appended: [], sendMessage: vi.fn() };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  /** Fresh module instance per test, so module-level state starts clean. */
  async function loadFactory(): Promise<(pi: any) => void> {
    vi.resetModules();
    const mod = await import("../src/index.ts");
    return mod.default;
  }

  it("--reset applies the requested role on the NEW session (regression: handoff survives factory re-invocation)", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);
    const s2 = makeSession(factory, cwd, shared);

    // pi's ctx.newSession(): clear history, then synchronously fire
    // session_start (reason="new") on the NEW session's runner.
    s1.ctx.newSession = async () => {
      await s2.emitSessionStart("new");
      return { cancelled: false };
    };

    const roleCmd = s1.commands.get("role")!;
    await roleCmd.handler("bare --reset", s1.ctx);

    const appliedNames = shared.toasts.map((t) => t.replace(/^Switched to role (\S+).*$/, "$1"));
    expect(appliedNames).toContain("bare");
    expect(shared.toasts.find((t) => t.startsWith("Switched to role bare"))).toBe(
      "Switched to role bare",
    );
    // The new session must NOT have started with the default pi role.
    expect(appliedNames).not.toContain("pi");
    expect(shared.sessionNames.some((n) => n.endsWith("- bare"))).toBe(true);
    // Notifications must never reach the LLM context (no sendMessage).
    expect(shared.sendMessage).not.toHaveBeenCalled();
  });

  it("cancelled --reset clears the handoff; the next session falls back to the default role", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);
    const s2 = makeSession(factory, cwd, shared);

    // User aborts at the confirm prompt: newSession returns cancelled and
    // does NOT fire session_start.
    s1.ctx.newSession = async () => ({ cancelled: true });

    const roleCmd = s1.commands.get("role")!;
    await roleCmd.handler("bare --reset", s1.ctx);
    // The cancel surfaces its own toast, but no role-switch notification.
    expect(shared.toasts).toEqual(['Role switch to "bare" cancelled.']);

    // A later manual new-session must not resurrect the cancelled handoff.
    s2.ctx.newSession = async () => ({ cancelled: false });
    await s2.emitSessionStart("new");

    const appliedNames = shared.toasts.map((t) => t.replace(/^Switched to role (\S+).*$/, "$1"));
    expect(appliedNames).toEqual(['Role switch to "bare" cancelled.', "pi"]); // default fallback, not bare
    expect(shared.sendMessage).not.toHaveBeenCalled();
  });

  it("plain /role <name> (no --reset) still applies mid-session", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);

    await s1.commands.get("role")!.handler("bare", s1.ctx);

    const appliedNames = shared.toasts.map((t) => t.replace(/^Switched to role (\S+).*$/, "$1"));
    expect(appliedNames).toEqual(["bare"]);
    expect(shared.toasts[0]).toBe("Switched to role bare");
    expect(shared.sendMessage).not.toHaveBeenCalled();
  });

  it("session_start with reason 'startup' is silent and uses the default role", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);

    await s1.emitSessionStart("startup");

    expect(shared.toasts).toHaveLength(0); // no "Switched to ..." banner
    expect(shared.sessionNames.some((n) => n.endsWith("- pi"))).toBe(true);
  });

  it("session_start with reason 'startup' on an existing session restores role + intent (pi -c / pi -r)", async () => {
    // Regression: pi's initial-runtime path never passes a sessionStartEvent,
    // so even a launch that CONTINUES an existing session (pi -c, pi -r,
    // pi --session <path>) fires session_start with reason "startup" — it is
    // indistinguishable from a genuinely new session at the event level. The
    // persisted active-role entry is the only signal; if the startup branch
    // ignores it, the role+intent get wiped to the default role and
    // "Intent not defined".
    const factory = await loadFactory();
    const persisted = {
      type: "custom",
      customType: ACTIVE_ROLE_ENTRY_TYPE,
      data: {
        name: "bare",
        source: "user",
        path: join(home, ".pi", "agent", "roles", "bare.md"),
        intent: "Fix login bug",
        appliedAt: Date.now(),
      } as const,
    };
    const s1 = makeSession(factory, cwd, shared, [persisted]);

    await s1.emitSessionStart("startup");

    // Role + intent restored, not reset to the default.
    expect(shared.sessionNames.at(-1)).toBe("Fix login bug - bare");
    // Restore is silent — no "Switched to ..." banner on launch.
    expect(shared.toasts).toHaveLength(0);
    // The re-persisted active-role entry must carry the intent forward; a
    // wipe here would make the NEXT resume lose it too.
    const lastAppended = shared.appended.at(-1);
    expect(lastAppended?.customType).toBe(ACTIVE_ROLE_ENTRY_TYPE);
    expect((lastAppended?.data as { intent?: string }).intent).toBe("Fix login bug");
    expect((lastAppended?.data as { name?: string }).name).toBe("bare");
  });

  it("session_start with reason 'resume' restores role + intent (same as startup-continue)", async () => {
    const factory = await loadFactory();
    const persisted = {
      type: "custom",
      customType: ACTIVE_ROLE_ENTRY_TYPE,
      data: {
        name: "bare",
        source: "user",
        path: join(home, ".pi", "agent", "roles", "bare.md"),
        intent: "Plan DB migration",
        appliedAt: Date.now(),
      } as const,
    };
    const s1 = makeSession(factory, cwd, shared, [persisted]);

    await s1.emitSessionStart("resume");

    expect(shared.sessionNames.at(-1)).toBe("Plan DB migration - bare");
    expect(shared.toasts).toHaveLength(0);
  });

  it("a persisted active-role entry without intent restores role with the placeholder name", async () => {
    // e.g. the user never sent a message (title-gen never ran) before exiting.
    const factory = await loadFactory();
    const persisted = {
      type: "custom",
      customType: ACTIVE_ROLE_ENTRY_TYPE,
      data: {
        name: "bare",
        source: "user",
        path: join(home, ".pi", "agent", "roles", "bare.md"),
        appliedAt: Date.now(),
      } as const,
    };
    const s1 = makeSession(factory, cwd, shared, [persisted]);

    await s1.emitSessionStart("startup");

    // Role restored, intent falls back to the placeholder (nothing to carry).
    expect(shared.sessionNames.at(-1)).toBe("Intent not defined - bare");
  });

  it("recovers the last-known intent when the latest entry lost it (heals pre-fix damage)", async () => {
    // Pre-fix launches persisted a fresh entry WITHOUT intent on continue,
    // so already-damaged files have: [.. entry WITH intent, latest entry
    // without]. The restore must fall back to the most recent intent.
    const factory = await loadFactory();
    const base = {
      type: "custom" as const,
      customType: ACTIVE_ROLE_ENTRY_TYPE,
      data: {
        name: "bare",
        source: "user",
        path: join(home, ".pi", "agent", "roles", "bare.md"),
        appliedAt: 1,
      } as const,
    };
    const s1 = makeSession(factory, cwd, shared, [
      { ...base, data: { ...base.data, intent: "User greets and asks identity" } },
      { ...base, data: { ...base.data, appliedAt: 2 } }, // latest: intent wiped
    ]);

    await s1.emitSessionStart("startup");

    expect(shared.sessionNames.at(-1)).toBe("User greets and asks identity - bare");
    // And the re-persisted entry carries the recovered intent forward.
    expect((shared.appended.at(-1)?.data as { intent?: string }).intent).toBe(
      "User greets and asks identity",
    );
  });
});
