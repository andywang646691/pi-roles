/**
 * Phase 6 tests: the bundled built-in roles — `role-assistant.md` and
 * `pi.md` — exist, parse, and surface in `discoverRoles` results so the
 * default and fallback paths work.
 */

import { describe, expect, it } from "vitest";
import {
  discoverRoles,
  findBuiltInAssistant,
  findBuiltInRole,
  resolveRole,
} from "../src/roles.ts";
import { builtInRoleAssistantPath, loadBuiltInRoleAssistant } from "../src/role-assistant.ts";
import {
  BUILTIN_PI_ROLE_NAME,
  BUILTIN_ROLE_ASSISTANT_NAME,
  PI_DEFAULT_PROMPT_MARKER,
} from "../src/schemas.ts";
import { existsSync } from "node:fs";

describe("built-in role-assistant", () => {
  it("file exists at the resolved path", () => {
    expect(existsSync(builtInRoleAssistantPath())).toBe(true);
  });

  it("parses without errors", () => {
    const role = loadBuiltInRoleAssistant();
    expect(role.frontmatter.name).toBe(BUILTIN_ROLE_ASSISTANT_NAME);
    expect(role.frontmatter.description).toBeTruthy();
    expect(role.body.length).toBeGreaterThan(0);
    expect(role.source).toBe("built-in");
  });

  it("has no model/thinking/tools restrictions (fallback inherits everything)", () => {
    const role = loadBuiltInRoleAssistant();
    expect(role.frontmatter.model).toBeUndefined();
    expect(role.frontmatter.thinking).toBeUndefined();
    // tools field absent → inherit (don't restrict the user's available tools)
    expect(role.frontmatter.tools).toBeUndefined();
  });

  it("appears in discoverRoles output as built-in", () => {
    // Use a tmp cwd that has no project .pi/roles so we don't pick up
    // unrelated roles from this dev checkout.
    const result = discoverRoles("/tmp", "user");
    const found = findBuiltInAssistant(result.roles);
    expect(found).toBeDefined();
    expect(found!.source).toBe("built-in");
  });

  it("resolveRole on the built-in returns a usable ResolvedRole", () => {
    const result = discoverRoles("/tmp", "user");
    const resolved = resolveRole(BUILTIN_ROLE_ASSISTANT_NAME, result.roles);
    expect(resolved.name).toBe(BUILTIN_ROLE_ASSISTANT_NAME);
    expect(resolved.body.length).toBeGreaterThan(0);
    // role-assistant doesn't extend pi: absent fields resolve to none.
    expect(resolved.tools).toEqual({ kind: "set", names: [] });
    expect(resolved.skills).toEqual({ kind: "set", names: [] });
  });
});

// ---------------------------------------------------------------------------
// built-in pi (the default role)
// ---------------------------------------------------------------------------

describe("built-in pi role", () => {
  it("appears in discoverRoles output as built-in", () => {
    const result = discoverRoles("/tmp", "user");
    const found = findBuiltInRole(result.roles, BUILTIN_PI_ROLE_NAME);
    expect(found).toBeDefined();
    expect(found!.source).toBe("built-in");
  });

  it("resolves to the default-prompt marker so compose can substitute the live prompt", () => {
    const result = discoverRoles("/tmp", "user");
    const resolved = resolveRole(BUILTIN_PI_ROLE_NAME, result.roles);
    expect(resolved.name).toBe(BUILTIN_PI_ROLE_NAME);
    expect(resolved.body).toBe(PI_DEFAULT_PROMPT_MARKER);
    // pi chain: tools = fresh-session baseline, skills = all (marker carries them).
    expect(resolved.tools).toEqual({ kind: "default" });
    expect(resolved.skills).toEqual({ kind: "all" });
    expect(resolved.source).toBe("built-in");
  });
});
