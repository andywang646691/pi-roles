/**
 * Phase 2 tests for src/roles.ts.
 *
 * We use vitest's tmp-dir support and lay down real .md files on disk for
 * discovery tests. Parse-level and resolve-level tests use the exported
 * `parseRoleSource` / `resolveRole` helpers directly without touching the FS,
 * which keeps them fast and lets us assert on cycle and missing-parent paths
 * without contriving directory layouts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RoleResolutionError,
  discoverRoles,
  findBuiltInRole,
  normalizeCollection,
  parseRoleSource,
  resolveRole,
} from "../src/roles.ts";
import { BUILTIN_PI_ROLE_NAME, PI_DEFAULT_PROMPT_MARKER, type RawRole } from "../src/schemas.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-roles-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // Vitest will clean up tmp eventually; we don't bother rming because OSes
  // garbage-collect /tmp.
  tmpDirs.length = 0;
});

function fm(opts: {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string | null | undefined;
  skills?: string | null | undefined;
  intercom?: string;
  extends?: string;
  body?: string;
}): string {
  const lines = [`name: ${opts.name}`];
  lines.push(`description: ${opts.description ?? "test role"}`);
  if (opts.model !== undefined) lines.push(`model: ${opts.model}`);
  if (opts.thinking !== undefined) lines.push(`thinking: ${opts.thinking}`);
  if (opts.intercom !== undefined) lines.push(`intercom: ${opts.intercom}`);
  if (opts.extends !== undefined) lines.push(`extends: ${opts.extends}`);
  if ("tools" in opts) {
    if (opts.tools === null) lines.push("tools:");
    else if (opts.tools === undefined) {
      // omit
    } else {
      lines.push(`tools: ${JSON.stringify(opts.tools)}`);
    }
  }
  if ("skills" in opts) {
    if (opts.skills === null) lines.push("skills:");
    else if (opts.skills === undefined) {
      // omit
    } else {
      lines.push(`skills: ${JSON.stringify(opts.skills)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n${opts.body ?? "Body for " + opts.name}`;
}

function rawFromText(text: string, name: string): RawRole {
  return parseRoleSource(text, `/virtual/${name}.md`, "project");
}

/** A built-in-scope role, e.g. the bundled `pi` or `role-assistant`. */
function builtInRole(name: string, body = `Body for ${name}`): RawRole {
  return parseRoleSource(
    `---\nname: ${name}\ndescription: built-in ${name}\n---\n${body}`,
    `/virtual/builtin/${name}.md`,
    "built-in",
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseRoleSource", () => {
  it("parses minimal frontmatter", () => {
    const r = rawFromText(fm({ name: "minimal" }), "minimal");
    expect(r.frontmatter.name).toBe("minimal");
    expect(r.frontmatter.description).toBe("test role");
    expect(r.body).toBe("Body for minimal");
  });

  it("parses full frontmatter", () => {
    const text = fm({
      name: "full",
      description: "Full role",
      model: "anthropic/claude-opus-4-7",
      thinking: "high",
      tools: "read, write, edit",
      intercom: "both",
      body: "System prompt body.",
    });
    const r = rawFromText(text, "full");
    expect(r.frontmatter.model).toBe("anthropic/claude-opus-4-7");
    expect(r.frontmatter.thinking).toBe("high");
    expect(r.frontmatter.intercom).toBe("both");
    expect(r.frontmatter.tools).toBe("read, write, edit");
  });

  it("rejects role with mismatched name/filename", () => {
    expect(() => parseRoleSource(fm({ name: "wrong" }), "/v/right.md", "project")).toThrow(
      /name.*"wrong".*"right"/,
    );
  });

  it("rejects invalid thinking value", () => {
    expect(() => rawFromText(fm({ name: "x", thinking: "bogus" }), "x")).toThrow(
      RoleResolutionError,
    );
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseRoleSource("no frontmatter here", "/v/x.md", "project")).toThrow(
      /missing or malformed frontmatter/,
    );
  });

  it("rejects malformed YAML", () => {
    expect(() => parseRoleSource("---\n: : :\n---\nbody", "/v/x.md", "project")).toThrow(
      RoleResolutionError,
    );
  });

  it("tolerates Windows line endings", () => {
    const text = "---\r\nname: win\r\ndescription: ok\r\n---\r\nbody";
    expect(rawFromText(text, "win").frontmatter.name).toBe("win");
  });
});

// ---------------------------------------------------------------------------
// Collection (tools / skills) normalization
// ---------------------------------------------------------------------------

describe("normalizeCollection", () => {
  it("absent → inherit", () => {
    expect(normalizeCollection(undefined)).toEqual({ kind: "inherit" });
  });
  it("null → set:[]", () => {
    expect(normalizeCollection(null)).toEqual({ kind: "set", names: [] });
  });
  it("empty string → set:[]", () => {
    expect(normalizeCollection("")).toEqual({ kind: "set", names: [] });
  });
  it("'a, b, c' → set:[a,b,c]", () => {
    expect(normalizeCollection("read, write,  edit")).toEqual({
      kind: "set",
      names: ["read", "write", "edit"],
    });
  });
  it("'all' → all kind", () => {
    expect(normalizeCollection("all")).toEqual({ kind: "all" });
  });
  it("' all ' (whitespace) → all kind", () => {
    expect(normalizeCollection("  all  ")).toEqual({ kind: "all" });
  });
  it("preserves mcp:* entries verbatim", () => {
    expect(normalizeCollection("read, mcp:fs, mcp:github")).toEqual({
      kind: "set",
      names: ["read", "mcp:fs", "mcp:github"],
    });
  });
});

// ---------------------------------------------------------------------------
// extends resolution
// ---------------------------------------------------------------------------

describe("resolveRole", () => {
  it("single-level inheritance overrides correctly", () => {
    const parent = rawFromText(
      fm({
        name: "parent",
        description: "p",
        model: "anthropic/claude-opus-4-7",
        thinking: "low",
        tools: "read, write",
        body: "Parent body.",
      }),
      "parent",
    );
    const child = rawFromText(
      fm({
        name: "child",
        description: "c",
        thinking: "high",
        extends: "parent",
        body: "Child body.",
      }),
      "child",
    );
    const resolved = resolveRole("child", [parent, child]);
    expect(resolved.name).toBe("child");
    expect(resolved.description).toBe("c");
    expect(resolved.model).toBe("anthropic/claude-opus-4-7"); // inherited
    expect(resolved.thinking).toBe("high"); // overridden
    expect(resolved.tools).toEqual({ kind: "set", names: ["read", "write"] }); // inherited
    expect(resolved.extendsChain).toEqual(["child", "parent"]);
  });

  it("chained 3-deep inheritance", () => {
    const a = rawFromText(fm({ name: "a", model: "x", body: "A." }), "a");
    const b = rawFromText(fm({ name: "b", extends: "a", thinking: "low", body: "B." }), "b");
    const c = rawFromText(fm({ name: "c", extends: "b", body: "C." }), "c");
    const r = resolveRole("c", [a, b, c]);
    expect(r.model).toBe("x");
    expect(r.thinking).toBe("low");
    expect(r.body).toBe("A.\n\n---\n\nB.\n\n---\n\nC.");
    expect(r.extendsChain).toEqual(["c", "b", "a"]);
  });

  it("cycle detection throws with helpful message", () => {
    const a = rawFromText(fm({ name: "a", extends: "b" }), "a");
    const b = rawFromText(fm({ name: "b", extends: "a" }), "b");
    expect(() => resolveRole("a", [a, b])).toThrow(/Cycle detected.*a.*b.*a/);
  });

  it("missing parent throws", () => {
    const c = rawFromText(fm({ name: "c", extends: "ghost" }), "c");
    expect(() => resolveRole("c", [c])).toThrow(/extends "ghost".*no such role/);
  });

  it("missing leaf role throws", () => {
    expect(() => resolveRole("nope", [])).toThrow(/not found/);
  });

  it("built-in pi resolves to the default-prompt marker, not its md body", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME, "Informational text for humans.");
    const resolved = resolveRole(BUILTIN_PI_ROLE_NAME, [pi]);
    expect(resolved.body).toBe(PI_DEFAULT_PROMPT_MARKER);
    expect(resolved.body).not.toContain("Informational text");
    expect(resolved.source).toBe("built-in");
  });

  it("child extending built-in pi prepends the marker to its body", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME, "Informational text for humans.");
    const child = rawFromText(
      fm({ name: "architect-strict", extends: BUILTIN_PI_ROLE_NAME, body: "Strict body." }),
      "architect-strict",
    );
    const resolved = resolveRole("architect-strict", [pi, child]);
    expect(resolved.body).toBe(`${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nStrict body.`);
    expect(resolved.extendsChain).toEqual(["architect-strict", BUILTIN_PI_ROLE_NAME]);
  });

  it("a user/project pi.md shadows the built-in and is treated as ordinary content", () => {
    // Discovery dedupes by name (project > user > built-in), so resolveRole
    // only ever sees the winning user-scope file.
    const userPi = parseRoleSource(
      `---\nname: ${BUILTIN_PI_ROLE_NAME}\ndescription: my own default\n---\nMy custom default body.`,
      `/home/u/.pi/agent/roles/${BUILTIN_PI_ROLE_NAME}.md`,
      "user",
    );
    const resolved = resolveRole(BUILTIN_PI_ROLE_NAME, [userPi]);
    expect(resolved.body).toBe("My custom default body.");
    expect(resolved.body).not.toContain(PI_DEFAULT_PROMPT_MARKER);
    expect(resolved.source).toBe("user");
  });

  it("findBuiltInRole finds by name at built-in scope only", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME);
    const projectPi = rawFromText(fm({ name: BUILTIN_PI_ROLE_NAME }), BUILTIN_PI_ROLE_NAME);
    expect(findBuiltInRole([projectPi, pi], BUILTIN_PI_ROLE_NAME)?.source).toBe("built-in");
    expect(findBuiltInRole([projectPi], BUILTIN_PI_ROLE_NAME)).toBeUndefined();
  });

  it("child tools=set:[] explicitly disables inherited tools", () => {
    const p = rawFromText(fm({ name: "p", tools: "read, write" }), "p");
    const c = rawFromText(fm({ name: "c", extends: "p", tools: null }), "c");
    expect(resolveRole("c", [p, c]).tools).toEqual({ kind: "set", names: [] });
  });

  it("child tools omitted inherits from parent", () => {
    const p = rawFromText(fm({ name: "p", tools: "read" }), "p");
    const c = rawFromText(fm({ name: "c", extends: "p" }), "c");
    expect(resolveRole("c", [p, c]).tools).toEqual({ kind: "set", names: ["read"] });
  });

  // ------------------------------------------------------- deterministic defaults

  it("plain role without tools/skills resolves both to none (deterministic)", () => {
    const r = rawFromText(fm({ name: "bare" }), "bare");
    const resolved = resolveRole("bare", [r]);
    expect(resolved.tools).toEqual({ kind: "set", names: [] });
    expect(resolved.skills).toEqual({ kind: "set", names: [] });
  });

  it("built-in pi resolves tools to default (baseline) and skills to all", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME);
    const resolved = resolveRole(BUILTIN_PI_ROLE_NAME, [pi]);
    expect(resolved.tools).toEqual({ kind: "default" });
    expect(resolved.skills).toEqual({ kind: "all" });
  });

  it("chain extending pi resolves tools to default and skills to all", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME);
    const child = rawFromText(fm({ name: "arch", extends: BUILTIN_PI_ROLE_NAME }), "arch");
    const resolved = resolveRole("arch", [pi, child]);
    expect(resolved.tools).toEqual({ kind: "default" });
    expect(resolved.skills).toEqual({ kind: "all" });
  });

  it("explicit tools on a pi-derived role wins over the default", () => {
    const pi = builtInRole(BUILTIN_PI_ROLE_NAME);
    const child = rawFromText(
      fm({ name: "arch", extends: BUILTIN_PI_ROLE_NAME, tools: "read, bash" }),
      "arch",
    );
    const resolved = resolveRole("arch", [pi, child]);
    expect(resolved.tools).toEqual({ kind: "set", names: ["read", "bash"] });
    expect(resolved.skills).toEqual({ kind: "all" }); // skills still inherited
  });

  it("explicit tools: all passes through to the all kind", () => {
    const r = rawFromText(fm({ name: "alltools", tools: "all" }), "alltools");
    expect(resolveRole("alltools", [r]).tools).toEqual({ kind: "all" });
  });

  it("explicit skills list merges through extends (leaf wins)", () => {
    const p = rawFromText(fm({ name: "p", skills: "git" }), "p");
    const c = rawFromText(fm({ name: "c", extends: "p", skills: "git, jira" }), "c");
    expect(resolveRole("c", [p, c]).skills).toEqual({ kind: "set", names: ["git", "jira"] });
  });

  it("child skills:null explicitly disables inherited skills", () => {
    const p = rawFromText(fm({ name: "p", skills: "git" }), "p");
    const c = rawFromText(fm({ name: "c", extends: "p", skills: null }), "c");
    expect(resolveRole("c", [p, c]).skills).toEqual({ kind: "set", names: [] });
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discoverRoles", () => {
  it("returns empty result when no role dirs exist", () => {
    const cwd = makeTmp();
    const result = discoverRoles(cwd, "project");
    // built-in dir may or may not exist depending on test working dir, but
    // shadowed should always be empty here.
    expect(result.shadowed).toEqual([]);
    for (const r of result.roles) expect(r.source).toBe("built-in");
  });

  it("project beats user beats built-in for same name", () => {
    // We can't easily clobber the user dir or built-in dir from a test
    // without mocking, so we exercise the project>user precedence by laying
    // down the same name in the project dir and verifying our entry wins.
    const cwd = makeTmp();
    const projectDir = join(cwd, ".pi", "roles");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "shared.md"),
      fm({ name: "shared", description: "from project" }),
    );

    const result = discoverRoles(cwd, "project");
    const winner = result.roles.find((r) => r.frontmatter.name === "shared");
    expect(winner).toBeDefined();
    expect(winner!.source).toBe("project");
    expect(winner!.frontmatter.description).toBe("from project");
  });

  it("walks up to find .pi/roles in an ancestor", () => {
    const cwd = makeTmp();
    const projectDir = join(cwd, ".pi", "roles");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "alpha.md"), fm({ name: "alpha" }));

    const nested = join(cwd, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });
    const result = discoverRoles(nested, "project");
    expect(result.roles.some((r) => r.frontmatter.name === "alpha")).toBe(true);
  });

  it("scope='user' skips project dir", () => {
    const cwd = makeTmp();
    const projectDir = join(cwd, ".pi", "roles");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "projonly.md"), fm({ name: "projonly" }));

    const result = discoverRoles(cwd, "user");
    expect(result.roles.some((r) => r.frontmatter.name === "projonly")).toBe(false);
  });
});
