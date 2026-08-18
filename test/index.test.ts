/**
 * Phase 4 tests for src/index.ts.
 *
 * Most of index.ts is integration glue around Pi events that's only worth
 * testing end-to-end. The pieces with non-trivial logic — role-name
 * precedence and the autocompletion provider — are exported and tested
 * here directly.
 */

import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  pickInitialRoleName,
  roleCompletions,
  substitutePiDefaultPrompt,
} from "../src/index.ts";
import { parseRoleSource, resolveRole } from "../src/roles.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiRolesSettings, RawRole, ResolvedRole } from "../src/schemas.ts";
import { BUILTIN_PI_ROLE_NAME, PI_DEFAULT_PROMPT_MARKER } from "../src/schemas.ts";
import { INTERCOM_TOOL_NAME } from "../src/intercom.ts";

function makePi(flags: Record<string, string | boolean | undefined> = {}): ExtensionAPI {
  return {
    getFlag: (name: string) => flags[name],
  } as unknown as ExtensionAPI;
}

function makeRole(name: string, description = "test"): RawRole {
  return parseRoleSource(
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    `/v/${name}.md`,
    "project",
  );
}

const ENV_BACKUP = process.env.PI_ROLE;
function withEnv(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.PI_ROLE;
  else process.env.PI_ROLE = value;
  try {
    fn();
  } finally {
    if (ENV_BACKUP === undefined) delete process.env.PI_ROLE;
    else process.env.PI_ROLE = ENV_BACKUP;
  }
}

// ---------------------------------------------------------------------------
// pickInitialRoleName
// ---------------------------------------------------------------------------

describe("pickInitialRoleName", () => {
  const roles = [makeRole("architect"), makeRole("planner")];

  it("--role flag wins over env, settings, and built-in", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "planner" };
      expect(pickInitialRoleName(makePi({ role: "architect" }), settings, roles)).toBe(
        "architect",
      );
    });
  });

  it("PI_ROLE env wins when no flag", () => {
    withEnv("planner", () => {
      const settings: PiRolesSettings = { defaultRole: "architect" };
      expect(pickInitialRoleName(makePi(), settings, roles)).toBe("planner");
    });
  });

  it("settings.defaultRole used when no flag/env", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "architect" }, roles)).toBe(
        "architect",
      );
    });
  });

  it("falls back to built-in when defaultRole missing from disk", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), { defaultRole: "ghost" }, roles)).toBe(
        BUILTIN_PI_ROLE_NAME,
      );
    });
  });

  it("falls back to built-in when nothing is set", () => {
    withEnv(undefined, () => {
      expect(pickInitialRoleName(makePi(), {}, roles)).toBe(BUILTIN_PI_ROLE_NAME);
    });
  });

  it("ignores empty flag string", () => {
    withEnv("planner", () => {
      expect(pickInitialRoleName(makePi({ role: "" }), {}, roles)).toBe("planner");
    });
  });
});

// ---------------------------------------------------------------------------
// roleCompletions
// ---------------------------------------------------------------------------

describe("roleCompletions", () => {
  const roles = [
    makeRole("architect", "Designs"),
    makeRole("planner", "Plans"),
    makeRole("orchestrator", "Coordinates"),
  ];

  it("empty prefix returns subcommands + all roles", () => {
    const items = roleCompletions("", roles);
    expect(items).not.toBeNull();
    const values = items!.map((i) => i.value);
    expect(values).toContain("list");
    expect(values).toContain("current");
    expect(values).toContain("reload");
    expect(values).toContain("architect");
    expect(values).toContain("planner");
    expect(values).toContain("orchestrator");
  });

  it("prefix narrows results", () => {
    const items = roleCompletions("arc", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("prefix matches subcommand", () => {
    const items = roleCompletions("re", roles);
    expect(items?.map((i) => i.value)).toEqual(["reload"]);
  });

  it("case insensitive", () => {
    const items = roleCompletions("ARC", roles);
    expect(items?.map((i) => i.value)).toEqual(["architect"]);
  });

  it("returns null when no match", () => {
    expect(roleCompletions("zzz", roles)).toBeNull();
  });

  it("each item has label and description", () => {
    const items = roleCompletions("a", roles);
    expect(items![0]).toMatchObject({
      value: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// composeSystemPrompt — replacement contract
// ---------------------------------------------------------------------------

describe("composeSystemPrompt", () => {
  function resolveSingle(name: string, body: string, intercom?: string): ResolvedRole {
    const fm = `---\nname: ${name}\ndescription: x${intercom ? `\nintercom: ${intercom}` : ""}\n---\n${body}`;
    return resolveRole(name, [parseRoleSource(fm, `/v/${name}.md`, "project")]);
  }

  function piWith(toolNames: string[], sessionName?: string): ExtensionAPI {
    return {
      getAllTools: () => toolNames.map((name) => ({ name, description: "", parameters: {} as any, sourceInfo: {} as any })),
      getSessionName: () => sessionName,
    } as unknown as ExtensionAPI;
  }

  it("returns undefined when no active role", () => {
    expect(composeSystemPrompt({ activeRole: null, settings: {} }, piWith([]))).toBeUndefined();
  });

  it("returns role body verbatim, ignoring any upstream system prompt", () => {
    const role = resolveSingle("architect", "You are an architect. Design only.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      "You are an expert coding assistant...",
    );
    expect(result).toEqual({ systemPrompt: "You are an architect. Design only." });
    // The critical assertion: we didn't compose with Pi's default. Custom
    // role bodies are authoritative and never read upstream prompt content.
    expect(result?.systemPrompt).not.toMatch(/coding assistant/);
  });

  // ----------------------------------------------------------- pi passthrough

  /** A ResolvedRole whose body is the built-in pi marker (as resolveRole produces). */
  function piRole(body: string = PI_DEFAULT_PROMPT_MARKER): ResolvedRole {
    return {
      name: BUILTIN_PI_ROLE_NAME,
      description: "Pi's default expert coding agent.",
      tools: { kind: "default" },
      skills: { kind: "all" },
      body,
      source: "built-in",
      path: "/v/pi.md",
      extendsChain: [BUILTIN_PI_ROLE_NAME],
    };
  }

  it("pi role substitutes Pi's live default prompt", () => {
    const base = "You are an expert coding assistant operating inside pi...";
    const result = composeSystemPrompt(
      { activeRole: piRole(), settings: {} },
      piWith([]),
      base,
    );
    expect(result).toEqual({ systemPrompt: base });
  });

  it("pi role degrades to no-override when base prompt is missing", () => {
    const result = composeSystemPrompt(
      { activeRole: piRole(), settings: {} },
      piWith([]),
      undefined,
    );
    // Returning undefined lets Pi keep its own base prompt.
    expect(result).toBeUndefined();
  });

  it("child of pi prepends the live default prompt to its own body", () => {
    const base = "You are an expert coding assistant operating inside pi...";
    const role = piRole(`${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nYou are a strict architect.`);
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      base,
    );
    expect(result?.systemPrompt).toBe(
      `${base}\n\n---\n\nYou are a strict architect.`,
    );
  });

  it("child of pi keeps its own body when base prompt is missing", () => {
    const role = piRole(`${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nYou are a strict architect.`);
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
    );
    expect(result).toEqual({ systemPrompt: "You are a strict architect." });
  });

  it("appends intercom addendum when mode!=off and intercom tool is registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/^Body\.\n\n## intercom/);
    expect(result?.systemPrompt).toContain("architect");
  });

  it("omits addendum when intercom tool is not registered", () => {
    const role = resolveSingle("architect", "Body.", "send");
    const result = composeSystemPrompt({ activeRole: role, settings: {} }, piWith([]));
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("omits addendum when intercom mode resolves to off", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "off" } },
      piWith([INTERCOM_TOOL_NAME]),
    );
    expect(result).toEqual({ systemPrompt: "Body." });
  });

  it("global settings.intercomMode applies when role doesn't override", () => {
    const role = resolveSingle("architect", "Body.");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { intercomMode: "both" } },
      piWith([INTERCOM_TOOL_NAME], "architect"),
    );
    expect(result?.systemPrompt).toMatch(/intercom \(both modes\)/);
  });

  // ----------------------------------------------------------- skills

  function twoSkills(): { name: string; description: string; filePath: string; baseDir: string; sourceInfo: any; disableModelInvocation: boolean }[] {
    return [
      {
        name: "git-review",
        description: "Review staged git changes.",
        filePath: "/v/.pi/skills/git-review/SKILL.md",
        baseDir: "/v/.pi/skills/git-review",
        sourceInfo: {},
        disableModelInvocation: false,
      },
      {
        name: "secret-keeper",
        description: "Handles secrets.",
        filePath: "/v/.pi/skills/secret-keeper/SKILL.md",
        baseDir: "/v/.pi/skills/secret-keeper",
        sourceInfo: {},
        disableModelInvocation: true,
      },
    ];
  }

  function resolveWithSkills(name: string, body: string, skills?: string | null): ResolvedRole {
    const lines = [`name: ${name}`, `description: x`];
    if (skills === null) lines.push("skills:");
    else if (skills !== undefined) lines.push(`skills: ${JSON.stringify(skills)}`);
    return resolveRole(name, [parseRoleSource(`---\n${lines.join("\n")}\n---\n${body}`, `/v/${name}.md`, "project")]);
  }

  it("skills: all appends the Agent-Skills listing after the body", () => {
    const role = resolveWithSkills("with-all", "Body.", "all");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
      twoSkills(),
    );
    expect(result?.systemPrompt.startsWith("Body.")).toBe(true);
    // The listing is Pi's own prose format (formatSkillsForPrompt), which
    // names every skill and carries its description.
    expect(result?.systemPrompt).toContain("git-review");
    expect(result?.systemPrompt).toContain("Review staged git changes.");
    // disable-model-invocation skills are excluded by formatSkillsForPrompt
    expect(result?.systemPrompt).not.toContain("secret-keeper");
    expect(result?.skillWarnings).toBeUndefined();
  });

  it("skills: list keeps exactly those and warns on unknown names", () => {
    const role = resolveWithSkills("with-list", "Body.", "git-review, nope");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
      twoSkills(),
    );
    expect(result?.systemPrompt).toContain("git-review");
    expect(result?.skillWarnings?.[0]).toContain('"nope"');
    expect(result?.systemPrompt).not.toContain("nope");
  });

  it("warnOnMissingMcp: false silences unknown-skill warnings", () => {
    const role = resolveWithSkills("with-list", "Body.", "nope");
    const result = composeSystemPrompt(
      { activeRole: role, settings: { warnOnMissingMcp: false } },
      piWith([]),
      undefined,
      twoSkills(),
    );
    expect(result?.systemPrompt).toBe("Body.");
    expect(result?.skillWarnings).toBeUndefined();
  });

  it("explicit disable-model-invocation skill is skipped with a warning", () => {
    const role = resolveWithSkills("with-disabled", "Body.", "secret-keeper");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
      twoSkills(),
    );
    expect(result?.systemPrompt).toBe("Body.");
    expect(result?.skillWarnings?.[0]).toContain("disable-model-invocation");
  });

  it("skills directive on a marker chain is ignored with a warning", () => {
    const role = piRole(
      `${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nYou are strict.`,
    );
    // Override the resolved skills directive to a narrowing one (as if the
    // child had written skills: git-review while extending pi).
    const narrowed: ResolvedRole = {
      ...role,
      skills: { kind: "set", names: ["git-review"] },
    };
    const result = composeSystemPrompt(
      { activeRole: narrowed, settings: {} },
      piWith([]),
      "base prompt",
      twoSkills(),
    );
    // No duplicate listing — the base blob already carries skills.
    expect(result?.systemPrompt).toBe("base prompt\n\n---\n\nYou are strict.");
    expect(result?.skillWarnings?.[0]).toMatch(/extends the built-in pi role/);
  });

  it("skills: all on a marker chain appends nothing and warns nothing", () => {
    const result = composeSystemPrompt(
      { activeRole: piRole(), settings: {} },
      piWith([]),
      "base prompt",
      twoSkills(),
    );
    expect(result).toEqual({ systemPrompt: "base prompt" });
  });

  it("skills directive with no loaded skills warns once and appends nothing", () => {
    const role = resolveWithSkills("no-skills", "Body.", "git-review");
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
      undefined,
    );
    expect(result?.systemPrompt).toBe("Body.");
    expect(result?.skillWarnings?.[0]).toMatch(/no skills are loaded/);
  });

  it("explicit empty skills appends nothing and warns nothing", () => {
    const role = resolveWithSkills("no-skills", "Body.", null);
    const result = composeSystemPrompt(
      { activeRole: role, settings: {} },
      piWith([]),
      undefined,
      twoSkills(),
    );
    expect(result).toEqual({ systemPrompt: "Body." });
  });
});

// ---------------------------------------------------------------------------
// substitutePiDefaultPrompt — marker substitution contract
// ---------------------------------------------------------------------------

describe("substitutePiDefaultPrompt", () => {
  it("returns body unchanged when no marker is present", () => {
    expect(substitutePiDefaultPrompt("Plain body.", "base")).toBe("Plain body.");
  });

  it("replaces a lone marker with the base prompt", () => {
    expect(substitutePiDefaultPrompt(PI_DEFAULT_PROMPT_MARKER, "base")).toBe("base");
  });

  it("prepends base to trailing content with the standard separator", () => {
    expect(
      substitutePiDefaultPrompt(`${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nChild.`, "base"),
    ).toBe("base\n\n---\n\nChild.");
  });

  it("drops the marker and keeps trailing content when base is missing", () => {
    expect(
      substitutePiDefaultPrompt(`${PI_DEFAULT_PROMPT_MARKER}\n\n---\n\nChild.`, undefined),
    ).toBe("Child.");
  });

  it("returns undefined when marker is all there is and base is missing", () => {
    expect(substitutePiDefaultPrompt(PI_DEFAULT_PROMPT_MARKER, undefined)).toBeUndefined();
  });

  it("treats an empty base like a missing one", () => {
    expect(substitutePiDefaultPrompt(PI_DEFAULT_PROMPT_MARKER, "  ")).toBeUndefined();
  });
});
