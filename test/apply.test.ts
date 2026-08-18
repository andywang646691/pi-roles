/**
 * Phase 3 tests for src/apply.ts.
 *
 * The pure helpers (`parseModelId`, `findModelInRegistry`,
 * `effectiveIntercomMode`, `filterToolsForRuntime`, `composeSessionName`)
 * are tested directly. `applyRole` is tested against a hand-rolled fake
 * `ExtensionAPI` + `ExtensionContext` — we only stub the methods apply.ts
 * actually calls, which keeps the surface area manageable and lets tests
 * fail loudly if apply.ts starts touching unexpected pi.* methods.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyRole,
  composeFooterStatus,
  composeSessionName,
  effectiveIntercomMode,
  filterToolsForRuntime,
  findModelInRegistry,
  parseModelId,
  type ApplyContext,
} from "../src/apply.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  STATUS_KEY,
  type ResolvedRole,
} from "../src/schemas.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeModel {
  id: string;
  provider: string;
  name?: string;
}

function makeRole(overrides: Partial<ResolvedRole> = {}): ResolvedRole {
  return {
    name: "test",
    description: "Test role",
    body: "system prompt body",
    source: "project",
    path: "/virtual/test.md",
    extendsChain: ["test"],
    tools: { kind: "inherit" },
    skills: { kind: "set", names: [] },
    ...overrides,
  };
}

interface FakeApi {
  pi: {
    setModel: ReturnType<typeof vi.fn>;
    setThinkingLevel: ReturnType<typeof vi.fn>;
    setActiveTools: ReturnType<typeof vi.fn>;
    getAllTools: ReturnType<typeof vi.fn>;
    setSessionName: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
  };
  ctx: {
    hasUI: boolean;
    ui: { setStatus: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
    modelRegistry: { find: ReturnType<typeof vi.fn>; getAll: ReturnType<typeof vi.fn> };
  };
}

function makeFake(
  opts: {
    models?: FakeModel[];
    setModelResult?: boolean;
    tools?: { name: string }[];
    hasUI?: boolean;
  } = {},
): FakeApi {
  const models = opts.models ?? [];
  const tools = opts.tools ?? [];
  const setModelResult = opts.setModelResult ?? true;
  return {
    pi: {
      setModel: vi.fn(async () => setModelResult),
      setThinkingLevel: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(() => tools.map((t) => ({ ...t, sourceInfo: {} }))),
      setSessionName: vi.fn(),
      appendEntry: vi.fn(),
    },
    ctx: {
      hasUI: opts.hasUI ?? true,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) =>
          models.find((m) => m.provider === provider && m.id === id),
        ),
        getAll: vi.fn(() => models),
      },
    },
  };
}

function applyCtxOf(fake: FakeApi, opts: Partial<ApplyContext> = {}): ApplyContext {
  return {
    pi: fake.pi as unknown as ApplyContext["pi"],
    ctx: fake.ctx as unknown as ApplyContext["ctx"],
    warnOnMissingMcp: opts.warnOnMissingMcp ?? true,
    intercomMode: opts.intercomMode,
    defaultTools: opts.defaultTools ?? [],
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseModelId", () => {
  it("'provider/id' → split", () => {
    expect(parseModelId("anthropic/claude-opus-4-7")).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-7",
    });
  });
  it("'id' → bare", () => {
    expect(parseModelId("claude-opus-4-7")).toEqual({ id: "claude-opus-4-7" });
  });
  it("treats trailing slash as bare", () => {
    expect(parseModelId("anthropic/")).toEqual({ id: "anthropic/" });
  });
  it("treats leading slash as bare", () => {
    expect(parseModelId("/foo")).toEqual({ id: "/foo" });
  });
});

describe("findModelInRegistry", () => {
  const registry = {
    find: (p: string, i: string) =>
      p === "anthropic" && i === "claude-opus-4-7"
        ? { id: "claude-opus-4-7", provider: "anthropic" }
        : undefined,
    getAll: () => [
      { id: "claude-opus-4-7", provider: "anthropic" },
      { id: "claude-opus-4-7", provider: "proxy" },
      { id: "haiku", provider: "anthropic" },
    ],
  } as unknown as Parameters<typeof findModelInRegistry>[0];

  it("qualified id resolves directly", () => {
    const r = findModelInRegistry(registry, "anthropic/claude-opus-4-7");
    expect(r.model?.provider).toBe("anthropic");
    expect(r.ambiguous).toBe(false);
  });
  it("bare id picks first and flags ambiguity", () => {
    const r = findModelInRegistry(registry, "claude-opus-4-7");
    expect(r.model).toBeDefined();
    expect(r.ambiguous).toBe(true);
  });
  it("bare id with one match is not ambiguous", () => {
    const r = findModelInRegistry(registry, "haiku");
    expect(r.model?.provider).toBe("anthropic");
    expect(r.ambiguous).toBe(false);
  });
  it("missing returns undefined model", () => {
    expect(findModelInRegistry(registry, "ghost").model).toBeUndefined();
  });
});

describe("effectiveIntercomMode", () => {
  const role = makeRole();
  it("per-role wins", () => {
    expect(effectiveIntercomMode({ ...role, intercom: "send" }, "off")).toBe("send");
  });
  it("falls back to global", () => {
    expect(effectiveIntercomMode(role, "both")).toBe("both");
  });
  it("defaults to 'off'", () => {
    expect(effectiveIntercomMode(role, undefined)).toBe("off");
  });
});

describe("filterToolsForRuntime", () => {
  it("inherit short-circuits", () => {
    const r = filterToolsForRuntime(
      { kind: "inherit" },
      new Set(["read"]),
      "off",
      false,
      true,
    );
    expect(r.kind).toBe("inherit");
  });

  it("drops missing mcp:* and warns", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["read", "mcp:fs", "mcp:gh"] },
      new Set(["read", "mcp:fs"]),
      "off",
      false,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["read", "mcp:fs"] });
    expect(r.warnings.some((w) => w.includes("mcp:gh"))).toBe(true);
  });

  it("missing mcp:* without warnOnMissingMcp = silent drop", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["mcp:fs"] },
      new Set(),
      "off",
      false,
      false,
    );
    expect(r).toMatchObject({ kind: "set", names: [], warnings: [] });
  });

  it("all → every registered tool, intercom enforced", () => {
    const r = filterToolsForRuntime(
      { kind: "all" },
      new Set(["read", "bash", "mcp:fs"]),
      "both",
      true,
      true,
    );
    expect(r).toMatchObject({
      kind: "set",
      names: ["read", "bash", "mcp:fs", "intercom"],
      warnings: [],
    });
  });

  it("all → intercom not duplicated when already active", () => {
    const r = filterToolsForRuntime(
      { kind: "all" },
      new Set(["intercom", "read"]),
      "send",
      true,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["intercom", "read"] });
  });

  it("default → restores the session-start baseline", () => {
    const r = filterToolsForRuntime(
      { kind: "default" },
      new Set(["read", "bash", "edit", "write", "intercom"]),
      "off",
      false,
      true,
      ["read", "bash", "edit", "write"],
    );
    expect(r).toMatchObject({
      kind: "set",
      names: ["read", "bash", "edit", "write"],
      warnings: [],
    });
  });

  it("default + intercom mode adds the intercom tool", () => {
    const r = filterToolsForRuntime(
      { kind: "default" },
      new Set(["read", "intercom"]),
      "receive",
      true,
      true,
      ["read"],
    );
    expect(r).toMatchObject({ kind: "set", names: ["read", "intercom"] });
  });

  it("unknown non-mcp tool warns but passes through", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["read", "future-tool"] },
      new Set(["read"]),
      "off",
      false,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["read", "future-tool"] });
    expect(r.warnings.some((w) => w.includes("future-tool"))).toBe(true);
  });

  it("dedupes tool names", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["read", "read", "write"] },
      new Set(["read", "write"]),
      "off",
      false,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["read", "write"] });
  });

  it("appends intercom when mode!=off and intercom is registered", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["read"] },
      new Set(["read", "intercom"]),
      "send",
      true,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["read", "intercom"] });
  });

  it("does not double-append intercom when already present", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["intercom", "read"] },
      new Set(["read", "intercom"]),
      "both",
      true,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["intercom", "read"] });
  });

  it("does not append intercom when intercom is unavailable", () => {
    const r = filterToolsForRuntime(
      { kind: "set", names: ["read"] },
      new Set(["read"]),
      "both",
      false,
      true,
    );
    expect(r).toMatchObject({ kind: "set", names: ["read"] });
  });
});

describe("composeSessionName", () => {
  it("empty/undefined intent → undefined (no session name to write)", () => {
    expect(composeSessionName(undefined, "architect")).toBeUndefined();
    expect(composeSessionName("", "architect")).toBeUndefined();
    expect(composeSessionName("   ", "architect")).toBeUndefined();
  });
  it("non-empty → '<intent> - <role>'", () => {
    expect(composeSessionName("designing schema", "architect")).toBe(
      "designing schema - architect",
    );
  });
});

describe("composeFooterStatus", () => {
  it("undefined intent → role name only (no placeholder)", () => {
    expect(composeFooterStatus("architect", undefined)).toBe("architect");
    expect(composeFooterStatus("architect", "")).toBe("architect");
    expect(composeFooterStatus("architect", "   ")).toBe("architect");
  });
  it("non-empty intent → '<intent> - <role>'", () => {
    expect(composeFooterStatus("architect", "designing schema")).toBe("designing schema - architect");
  });
});

// ---------------------------------------------------------------------------
// applyRole integration
// ---------------------------------------------------------------------------

describe("applyRole", () => {
  it("happy path: applies model, thinking, tools, footer, name, persists, notifies", async () => {
    const fake = makeFake({
      models: [{ id: "claude-opus-4-7", provider: "anthropic", name: "Opus" }],
      tools: [{ name: "read" }, { name: "write" }],
    });
    const role = makeRole({
      model: "anthropic/claude-opus-4-7",
      thinking: "high",
      tools: { kind: "set", names: ["read", "write"] },
    });

    const result = await applyRole(role, applyCtxOf(fake));

    expect(result.warnings).toEqual([]);
    expect(fake.pi.setModel).toHaveBeenCalledTimes(1);
    expect(fake.pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(fake.pi.setActiveTools).toHaveBeenCalledWith(["read", "write"]);
    expect(fake.ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "test");
    expect(fake.pi.setSessionName).toHaveBeenCalledWith("");
    expect(fake.pi.appendEntry).toHaveBeenCalledWith(
      ACTIVE_ROLE_ENTRY_TYPE,
      expect.objectContaining({ name: "test", source: "project" }),
    );
    // Toast only — never a persisted/sendMessage notification: the fake pi
    // surface has no sendMessage at all, so any call would fail loudly.
    expect((fake.pi as Record<string, unknown>).sendMessage).toBeUndefined();
    expect(fake.ctx.ui.notify).toHaveBeenCalledWith("Switched to role test", "info");
  });

  it("missing model → warning, keeps current", async () => {
    const fake = makeFake({ models: [] });
    const role = makeRole({ model: "anthropic/ghost" });
    const result = await applyRole(role, applyCtxOf(fake));
    expect(fake.pi.setModel).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.includes("ghost"))).toBe(true);
  });

  it("setModel returns false → warning emitted", async () => {
    const fake = makeFake({
      models: [{ id: "x", provider: "p" }],
      setModelResult: false,
    });
    const role = makeRole({ model: "p/x" });
    const result = await applyRole(role, applyCtxOf(fake));
    expect(result.warnings.some((w) => w.includes("API key"))).toBe(true);
  });

  it("ambiguous bare id → warning, picks first", async () => {
    const fake = makeFake({
      models: [
        { id: "x", provider: "a" },
        { id: "x", provider: "b" },
      ],
    });
    const role = makeRole({ model: "x" });
    const result = await applyRole(role, applyCtxOf(fake));
    expect(fake.pi.setModel).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((w) => w.includes("multiple providers"))).toBe(true);
  });

  it("inherit tools → does not call setActiveTools", async () => {
    const fake = makeFake();
    const role = makeRole({ tools: { kind: "inherit" } });
    await applyRole(role, applyCtxOf(fake));
    expect(fake.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("explicit empty tools → setActiveTools([])", async () => {
    const fake = makeFake();
    const role = makeRole({ tools: { kind: "set", names: [] } });
    await applyRole(role, applyCtxOf(fake));
    expect(fake.pi.setActiveTools).toHaveBeenCalledWith([]);
  });

  it("intercom requested but tool not registered → warning", async () => {
    const fake = makeFake({ tools: [{ name: "read" }] });
    const role = makeRole({
      intercom: "both",
      tools: { kind: "set", names: ["read"] },
    });
    const result = await applyRole(role, applyCtxOf(fake));
    expect(result.warnings.some((w) => w.includes("intercom"))).toBe(true);
  });

  it("silent option suppresses the toast notification", async () => {
    const fake = makeFake();
    await applyRole(makeRole(), applyCtxOf(fake), { silent: true });
    expect(fake.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("preservedIntent flows into session name and persisted state", async () => {
    const fake = makeFake();
    await applyRole(makeRole({ name: "architect" }), applyCtxOf(fake), {
      preservedIntent: "wiring schemas",
    });
    expect(fake.pi.setSessionName).toHaveBeenCalledWith("wiring schemas - architect");
    expect(fake.pi.appendEntry).toHaveBeenCalledWith(
      ACTIVE_ROLE_ENTRY_TYPE,
      expect.objectContaining({ intent: "wiring schemas" }),
    );
  });

  it("no intent → clears the session name so Pi's native first-prompt title shows", async () => {
    // Regression: pi-roles used to pin the title to "Intent not defined - role"
    // whenever intent was missing. That placeholder overrides Pi's own title
    // logic (first user prompt) and depends on the title model's network call
    // succeeding — if upstream fails, the title is stuck forever. applyRole
    // must instead clear the name (""), letting Pi fall back to its native
    // behavior until (if ever) a real intent is generated.
    const fake = makeFake();
    await applyRole(makeRole({ name: "architect" }), applyCtxOf(fake));
    expect(fake.pi.setSessionName).toHaveBeenCalledWith("");
    expect(fake.ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "architect");
  });

  it("hasUI=false skips setStatus", async () => {
    const fake = makeFake({ hasUI: false });
    await applyRole(makeRole(), applyCtxOf(fake));
    expect(fake.ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("notification toast includes warning count when warnings exist", async () => {
    const fake = makeFake({ tools: [{ name: "read" }] });
    const role = makeRole({
      tools: { kind: "set", names: ["read", "mcp:missing"] },
    });
    await applyRole(role, applyCtxOf(fake, { warnOnMissingMcp: true }));
    const call = fake.ctx.ui.notify.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/1 warning/);
  });
});
