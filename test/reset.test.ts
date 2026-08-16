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
  /** Every pi.sendMessage payload across all fake sessions. */
  messages: Array<{ content: string; details?: { name: string } }>;
  /** Every pi.setSessionName call across all fake sessions. */
  sessionNames: string[];
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
    appendEntry: () => {},
    sendMessage: (msg: { content: string; details?: { name: string } }) => {
      shared.messages.push(msg);
    },
    // test hooks (not part of the ExtensionAPI surface)
    handlers,
    commands,
  };
}

function makeFakeCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    newSession: undefined as unknown,
    waitForIdle: async () => {},
  };
}

function makeSession(factory: (pi: any) => void, cwd: string, shared: Shared): FakeSession {
  const pi = makeFakePi(shared);
  factory(pi); // <-- pi calls the factory once per session/runtime
  const ctx = makeFakeCtx(cwd);
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
    shared = { messages: [], sessionNames: [] };
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

    const appliedNames = shared.messages.map((m) => m.details?.name);
    expect(appliedNames).toContain("bare");
    expect(shared.messages.find((m) => m.details?.name === "bare")?.content).toBe(
      "Switched to role bare",
    );
    // The new session must NOT have started with the default pi role.
    expect(appliedNames).not.toContain("pi");
    expect(shared.sessionNames.some((n) => n.endsWith("- bare"))).toBe(true);
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
    expect(shared.messages).toHaveLength(0);

    // A later manual new-session must not resurrect the cancelled handoff.
    s2.ctx.newSession = async () => ({ cancelled: false });
    await s2.emitSessionStart("new");

    const appliedNames = shared.messages.map((m) => m.details?.name);
    expect(appliedNames).toEqual(["pi"]); // default fallback, not bare
  });

  it("plain /role <name> (no --reset) still applies mid-session", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);

    await s1.commands.get("role")!.handler("bare", s1.ctx);

    const appliedNames = shared.messages.map((m) => m.details?.name);
    expect(appliedNames).toEqual(["bare"]);
    expect(shared.messages[0]?.content).toBe("Switched to role bare");
  });

  it("session_start with reason 'startup' is silent and uses the default role", async () => {
    const factory = await loadFactory();
    const s1 = makeSession(factory, cwd, shared);

    await s1.emitSessionStart("startup");

    expect(shared.messages).toHaveLength(0); // no "Switched to ..." banner
    expect(shared.sessionNames.some((n) => n.endsWith("- pi"))).toBe(true);
  });
});
