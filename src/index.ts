/**
 * pi-roles extension entry point.
 *
 * Wires together discovery (roles.ts), application (apply.ts), and settings
 * (settings.ts) into the three Pi integration points the role lifecycle
 * actually needs:
 *
 *   - `session_start` — restore from persisted state on reload/resume,
 *     otherwise resolve a role name from the precedence chain (pendingReset
 *     > --role > PI_ROLE > settings.defaultRole > built-in pi)
 *     and apply it.
 *   - `before_agent_start` — re-inject the active role's body as the system
 *     prompt every turn (Pi rebuilds the prompt per turn; this is the
 *     stable hook).
 *   - `/role` command — list, current, reload, switch (with optional
 *     --reset to clear history first).
 *
 * The module-scoped state below is the source of truth for "what role is
 * live in this extension instance". Pi reloads spin up a fresh module, at
 * which point we restore from the most recent `pi-roles:active-role` entry
 * in the session log.
 *
 * Scoping note: everything in `state` is per-session and lives inside the
 * factory closure. Only `pendingRoleAfterReset` lives at true module scope
 * (see its declaration) — it is the one piece of state that must survive
 * `ctx.newSession()`, and pi re-invokes the factory for every new session.
 */

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { applyRole, effectiveIntercomMode, resetSession } from "./apply.ts";
import { intercomPromptAddendum, isIntercomAvailable } from "./intercom.ts";
import { discoverRoles, findBuiltInRole, resolveRole, RoleResolutionError } from "./roles.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  BUILTIN_PI_ROLE_NAME,
  PI_DEFAULT_PROMPT_MARKER,
  type ActiveRoleState,
  type PiRolesSettings,
  type RawRole,
  type ResolvedRole,
  type SkillsDirective,
} from "./schemas.ts";
import { loadSettings } from "./settings.ts";
import { generateAndApplyTitle } from "./title.ts";
import { debugLog } from "./debug.ts";

const FLAG_NAME = "role";
const ENV_VAR = "PI_ROLE";
const SUBCOMMANDS = ["list", "current", "reload"] as const;

/**
 * Role name to apply on the NEXT `session_start` with reason "new", set by
 * `/role <name> --reset` and consumed+cleared by the session_start handler.
 *
 * This MUST live at true module scope, NOT inside the factory closure: pi
 * re-invokes the extension factory for every session (new ExtensionRunner
 * -> loadExtension -> factory(api)), so any state captured in the closure
 * is recreated per session and the handoff would be lost — the new session
 * would silently fall back to the default `pi` role (regression fixed in
 * 0.3.x: `--reset` always landed on pi).
 *
 * The module instance itself IS reused across sessions within a process
 * (jiti factory cache, keyed by cwd + generation), so this variable
 * survives `ctx.newSession()`. `/reload` re-imports the module and loses
 * it, but reload/resume restore from the session log
 * (`pi-roles:active-role` entry), which is independent of this flag.
 */
let pendingRoleAfterReset: string | null = null;

interface RuntimeState {
  /** Live role applied to this session, or null before first apply. */
  activeRole: ResolvedRole | null;
  /** Cached discovery result; refreshed on session_start, every `/role` invocation, and `/role reload`. */
  roles: RawRole[];
  /** Shadowed roles found at lower-precedence scopes; shown in `/role list`. */
  shadowed: { name: string; source: string; path: string }[];
  /** Cached settings for the current cwd; refreshed on session_start. */
  settings: PiRolesSettings;
  /** Carried across role swaps so the session-name intent survives a role change. */
  intent: string | undefined;
  /**
   * True while a title-generation request is in flight. Prevents
   * `before_agent_start` from spawning a second concurrent summarization
   * if it fires again before the first resolves. Reset to false in
   * `generateAndApplyTitle`'s finally block.
   */
  titleInFlight: boolean;
  /**
   * True after we've shown the one-time title-generation error hint.
   * Prevents spamming the user on every prompt when the title model
   * is misconfigured or lacks credentials.
   */
  titleErrorShown: boolean;
  /**
   * Pi's fresh-session active tool set, captured on `session_start` BEFORE
   * any role is applied. This is the pristine baseline that the
   * `{ kind: "default" }` tools directive (chains extending built-in pi)
   * restores — "what an unextended pi session would have". Snapshotting
   * instead of hardcoding respects user global config and MCP auto-enable.
   */
  baselineTools: string[];
  /**
   * Key of the last skills warning set shown to the user (role name + joined
   * warnings). `before_agent_start` fires every turn; we only notify once per
   * distinct set so a misconfigured role can't spam toasts.
   */
  skillsWarnedKey: string | null;
}

export default function (pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRole: null,
    roles: [],
    shadowed: [],
    settings: {},
    intent: undefined,
    titleInFlight: false,
    titleErrorShown: false,
    baselineTools: [],
    skillsWarnedKey: null,
  };

  /** Re-read settings + re-discover roles from disk. Centralized so every */
  /** entry point that needs fresh state ({@link session_start}, every `/role` */
  /** invocation, `/role reload`) goes through one path. */
  const refreshFromDisk = (cwd: string): void => {
    state.settings = loadSettings(cwd);
    const discovery = discoverRoles(cwd, state.settings.roleScope ?? "both");
    state.roles = discovery.roles;
    state.shadowed = discovery.shadowed;
  };

  // --------------------------------------------------------------------- flag
  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: "Launch as the named pi-roles role (e.g. --role architect).",
  });

  // --------------------------------------------------------------- session_start
  pi.on("session_start", async (event, ctx) => {
    refreshFromDisk(ctx.cwd);

    // Snapshot the pristine toolset BEFORE any role touches it. This is the
    // reference for the `tools` default directive (chains extending pi): a
    // fresh session's active set, including user config and MCP auto-enable.
    state.baselineTools = captureBaselineTools(pi);

    const restored = findRestoredState(ctx);
    debugLog("index", `session_start reason=${event.reason}`, restored ? { name: restored.name, intent: restored.intent } : undefined);

    // Restore precedence:
    //   - pendingRoleAfterReset (from `/role X --reset`) wins: --reset is a
    //     fresh start, so intent is deliberately not carried over.
    //   - Otherwise, a persisted active-role entry wins whenever the session
    //     has one. This covers reload and in-process session switching
    //     (reason "resume"), but also continued launches (pi -c / pi -r /
    //     pi --session <path>): pi's initial-runtime path never passes a
    //     sessionStartEvent, so even a launch that opened an existing
    //     session fires session_start with reason "startup". A fork also
    //     copies the branch's entries (including the active-role entry), so
    //     forked sessions keep the role+intent active at the fork point.
    //   - Only a genuinely new session (fresh file — no entries) falls
    //     through to fresh resolution from the chain below.
    let targetName: string | undefined;
    let preservedIntent: string | undefined;
    let silent = false;

    if (pendingRoleAfterReset) {
      targetName = pendingRoleAfterReset;
      pendingRoleAfterReset = null;
      // intent is intentionally cleared on --reset (session is a fresh start).
    } else if (restored) {
      targetName = restored.name;
      preservedIntent = restored.intent;
      silent = true;
    } else {
      targetName = pickInitialRoleName(pi, state.settings, state.roles);
      // First-application is silent — the user knows what they launched
      // with; a banner here would be noise.
      silent = event.reason === "startup";
    }

    state.intent = preservedIntent;
    await applyResolved(pi, ctx, state, targetName, { silent, preservedIntent });
  });

  // ----------------------------------------------------------- before_agent_start
  // Full replacement: the role body IS the system prompt for this turn.
  //
  // We intentionally ignore `event.systemPrompt` (Pi's default coding-assistant
  // framing plus anything earlier extensions in the chain produced). The
  // founding goal of pi-roles is to make the role body authoritative — a
  // non-coding role (marketing, research, ops) must not inherit the default
  // "expert coding assistant" voice or it stops behaving like its description.
  //
  // Pi's docstring on BeforeAgentStartEventResult.systemPrompt says exactly
  // "Replace the system prompt for this turn"; that is what we do.
  // Subsequent extensions in the chain see our value as their
  // event.systemPrompt and may compose if they choose.
  //
  // Side effect — title generation. When this is the first prompt of the
  // session (no intent persisted yet), kick off an async summarization to
  // populate the session-name "intent" half. We don't await: the agent
  // loop should start immediately, and the session name update can race
  // independently. `generateAndApplyTitle` handles guards (already-set,
  // already-running, no-model) internally.
  pi.on("before_agent_start", async (event, ctx) => {
    debugLog("index", "before_agent_start fired", {
      hasActiveRole: !!state.activeRole,
      hasIntent: !!state.intent,
      inFlight: state.titleInFlight,
      promptLen: event?.prompt?.length ?? 0,
      ctxModelId: (ctx as any)?.model?.id,
    });
    if (
      state.activeRole &&
      !state.intent &&
      !state.titleInFlight &&
      event.prompt &&
      event.prompt.trim().length > 0
    ) {
      debugLog("index", "triggering title generation", { promptPreview: event.prompt.slice(0, 80), model: state.settings.titleModel });
      void generateAndApplyTitle({
        prompt: event.prompt,
        state,
        pi,
        ctx,
        configuredTitleModel: state.settings.titleModel,
      });
    }
    const composed = composeSystemPrompt(state, pi, event?.systemPrompt, event?.systemPromptOptions?.skills);
    if (composed?.skillWarnings?.length) {
      // before_agent_start fires every turn; only surface a given warning set
      // once per role application so a broken role can't spam toasts.
      const key = `${state.activeRole?.name ?? "?"}|${composed.skillWarnings.join("\u241f")}`;
      if (state.skillsWarnedKey !== key) {
        state.skillsWarnedKey = key;
        if (ctx.hasUI) {
          for (const w of composed.skillWarnings) ctx.ui.notify(`pi-roles: ${w}`, "warning");
        }
      }
    }
    return composed ? { systemPrompt: composed.systemPrompt } : undefined;
  });

  // ---------------------------------------------------------------- /role
  pi.registerCommand("role", {
    description: "Switch session role. /role list | current | reload | <name> [--reset]",
    getArgumentCompletions: (prefix) => roleCompletions(prefix, state.roles),
    handler: async (args, ctx) => {
      // README guarantees "/role <name> always re-reads from disk". Refresh
      // before any subcommand so /list shows new files and /<name> picks up
      // edits without an explicit /role reload.
      refreshFromDisk(ctx.cwd);

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub || sub === "list") {
        return handleList(ctx, state);
      }
      if (sub === "current") {
        return handleCurrent(ctx, state);
      }
      if (sub === "reload") {
        return handleReload(pi, ctx, state);
      }

      const wantsReset = tokens.includes("--reset");
      const name = sub;

      if (wantsReset) {
        // Set the pending pointer FIRST: ctx.newSession() invalidates
        // session-bound captured state and synchronously fires session_start
        // before returning, so we can't apply the role after newSession()
        // resolves and expect mid-session ordering to hold.
        pendingRoleAfterReset = name;
        const result = await resetSession(ctx);
        if (result.cancelled) {
          pendingRoleAfterReset = null;
          ctx.ui.notify(`Role switch to "${name}" cancelled.`, "info");
        }
        return;
      }

      await applyResolved(pi, ctx, state, name, { silent: false, preservedIntent: state.intent });
    },
  });
}

// ---------------------------------------------------------------------------
// Role-name resolution
// ---------------------------------------------------------------------------

/**
 * Build the replacement system prompt for the current active role.
 *
 * Returns `undefined` when there's no active role (Pi keeps its default for
 * that turn). Otherwise returns `{ systemPrompt }` with the role body — plus,
 * when the role opts into skills, the Agent-Skills XML listing, and when
 * intercom is requested AND the intercom tool is registered, a small
 * mode-specific addendum. Warning text (missing/unknown skills, ignored
 * narrowing on extends:pi chains) comes back in `skillWarnings` so the caller
 * can surface it once; it is intentionally NOT part of the prompt.
 *
 * The `baseSystemPrompt` is Pi's fully-built default system prompt for this
 * turn (`event.systemPrompt`). It's used only to substitute
 * `PI_DEFAULT_PROMPT_MARKER` segments in the role body — i.e. the built-in
 * `pi` role and any chain that `extends: pi`. Everything else is returned
 * verbatim; custom role bodies are authoritative and never composed with
 * upstream prompt content.
 *
 * `loadedSkills` is Pi's per-turn loaded skill set
 * (`event.systemPromptOptions.skills`) — the same structured data Pi uses to
 * render the default prompt's skill listing. Skills make it into the prompt
 * ONLY for chains without the built-in pi marker; a marker chain's live
 * default prompt already contains every loaded skill, so appending a second
 * listing would duplicate it (see composeSkillsBlock).
 *
 * Exported for unit tests; the handler in `before_agent_start` is a one-line
 * delegation.
 */
export function composeSystemPrompt(
  state: Pick<RuntimeState, "activeRole" | "settings">,
  pi: Pick<ExtensionAPI, "getAllTools" | "getSessionName">,
  baseSystemPrompt?: string,
  loadedSkills?: Skill[],
): { systemPrompt: string; skillWarnings?: string[] } | undefined {
  if (!state.activeRole) return undefined;
  const body = substitutePiDefaultPrompt(state.activeRole.body, baseSystemPrompt);
  if (!body) return undefined;
  const mode = effectiveIntercomMode(state.activeRole, state.settings.intercomMode);
  const addendum =
    mode !== "off" && isIntercomAvailable(pi as ExtensionAPI)
      ? intercomPromptAddendum(mode, pi.getSessionName())
      : "";
  const { block: skillsBlock, warnings: skillWarnings } = composeSkillsBlock(
    state.activeRole.skills,
    state.activeRole.body,
    loadedSkills,
    state.settings.warnOnMissingMcp ?? true,
  );
  const parts = [body, skillsBlock, addendum].filter((p) => p && p.length > 0);
  if (parts.length === 0) return undefined;
  const result: { systemPrompt: string; skillWarnings?: string[] } = {
    systemPrompt: parts.join("\n\n"),
  };
  if (skillWarnings.length > 0) result.skillWarnings = skillWarnings;
  return result;
}

/**
 * Resolve a role's `skills` directive against the loaded skill set and render
 * the Agent-Skills XML listing for the system prompt.
 *
 * Returns `{ block: undefined }` when the role gets no skills; otherwise the
 * rendered listing (generated by Pi's own `formatSkillsForPrompt`, so the
 * output is byte-identical to what Pi's default prompt emits).
 *
 * Rules (mirror docs in README "skills frontmatter"):
 *   - marker chain (role body contains `PI_DEFAULT_PROMPT_MARKER`, i.e.
 *     `extends: pi`): the live default prompt already includes every loaded
 *     skill, so nothing is appended. A narrowing directive (list or
 *     explicit-empty) cannot subtract from that blob and is ignored with a
 *     warning; `all` needs no block and no warning.
 *   - non-marker chain + `all`: every loaded skill.
 *   - non-marker chain + list: exactly those; unknown names are skipped
 *     with a warning (gated on `warnOnMissing`), and skills with
 *     `disable-model-invocation: true` are skipped with a warning (they are
 *     only reachable via `/skill:name` and are excluded by
 *     `formatSkillsForPrompt` anyway).
 *   - explicit empty: no skills, no warning.
 */
export function composeSkillsBlock(
  directive: SkillsDirective | undefined,
  roleBody: string,
  loadedSkills: Skill[] | undefined,
  warnOnMissing: boolean,
): { block?: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!directive || directive.kind === "inherit" || roleBody.includes(PI_DEFAULT_PROMPT_MARKER)) {
    // Defensive: resolved roles never carry `inherit`, but direct
    // constructions in tests do. Marker chains: the default prompt blob
    // already carries skills — a narrowing directive can't subtract from it.
    if (directive && directive.kind === "set" && roleBody.includes(PI_DEFAULT_PROMPT_MARKER)) {
      const what =
        directive.names.length > 0
          ? `requests subset [${directive.names.join(", ")}] but`
          : `disables skills but`;
      if (warnOnMissing) {
        warnings.push(
          `role's skills directive ${what} it extends the built-in pi role, whose default prompt already includes all loaded skills. The directive is ignored.`,
        );
      }
    }
    return { warnings };
  }

  if (directive.kind === "set" && directive.names.length === 0) return { warnings };

  if (!loadedSkills || loadedSkills.length === 0) {
    if (warnOnMissing) {
      warnings.push(
        `skills: no skills are loaded for this session; none were added. Check .pi/skills/, ~/.pi/agent/skills/, or --skill.`,
      );
    }
    return { warnings };
  }

  const byName = new Map<string, Skill>();
  for (const s of loadedSkills) if (!byName.has(s.name)) byName.set(s.name, s);

  let selected: Skill[];
  if (directive.kind === "all") {
    selected = loadedSkills;
  } else {
    selected = [];
    const seen = new Set<string>();
    for (const name of directive.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const skill = byName.get(name);
      if (!skill) {
        if (warnOnMissing) {
          warnings.push(`skills: skill "${name}" is not loaded for this session. Skipping.`);
        }
        continue;
      }
      if (skill.disableModelInvocation) {
        if (warnOnMissing) {
          warnings.push(
            `skills: skill "${name}" has disable-model-invocation: true; it is only reachable via /skill:name. Skipping.`,
          );
        }
        continue;
      }
      selected.push(skill);
    }
  }

  if (selected.length === 0) return { warnings };
  return { block: formatSkillsForPrompt(selected), warnings };
}

/**
 * Snapshot Pi's pristine active tool set on `session_start`, before any role
 * mutates it. Best-effort: if the API is unavailable that early, fall back to
 * all registered non-MCP tools, then to the empty set.
 */
function captureBaselineTools(pi: ExtensionAPI): string[] {
  try {
    return pi.getActiveTools();
  } catch (err) {
    debugLog("index", "baseline tool snapshot failed; falling back to non-MCP registered tools", String(err));
    try {
      return pi.getAllTools().map((t) => t.name).filter((n) => !n.startsWith("mcp:"));
    } catch {
      return [];
    }
  }
}

/**
 * Replace `PI_DEFAULT_PROMPT_MARKER` segments in a role body with Pi's live
 * default system prompt.
 *
 * - No marker → body returned unchanged (the common case).
 * - Marker + base prompt → marker replaced by the base prompt.
 * - Marker but no base prompt (e.g. a test, or another extension replaced
 *   the prompt earlier in the chain) → marker dropped, remaining segments
 *   joined with the standard separator. If nothing is left, returns
 *   `undefined`, which tells Pi to keep its own base prompt — the `pi` role
 *   degrades to "no override" rather than emitting a stale copy.
 */
export function substitutePiDefaultPrompt(
  body: string,
  baseSystemPrompt: string | undefined,
): string | undefined {
  const segments = body.split(PI_DEFAULT_PROMPT_MARKER);
  if (segments.length === 1) return body;
  // Segments may carry the "\n\n---\n\n" separator resolveRole inserted
  // around the marker; strip it so the remaining content joins cleanly.
  const rest = segments
    .map((s) => s.trim())
    .map((s) => s.replace(/^---\s*/, "").replace(/\s*---$/, "").trim())
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
  const usable = baseSystemPrompt && baseSystemPrompt.trim().length > 0 ? baseSystemPrompt : undefined;
  if (usable) return rest.length > 0 ? `${usable}\n\n---\n\n${rest}` : usable;
  return rest.length > 0 ? rest : undefined;
}

/**
 * Pick the role to launch with on a fresh session_start (no pendingReset, no
 * persisted state to restore). Precedence per BUILD-STATUS.md:
 *
 *   --role flag > PI_ROLE env > settings.defaultRole > built-in pi
 *
 * If a configured `defaultRole` doesn't exist, we fall through to the
 * built-in `pi` rather than failing — a missing role shouldn't lock the
 * user out of the session, and `pi` reproduces Pi's out-of-the-box
 * behavior.
 */
export function pickInitialRoleName(
  pi: ExtensionAPI,
  settings: PiRolesSettings,
  roles: RawRole[],
): string {
  const flagValue = pi.getFlag(FLAG_NAME);
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;

  const env = process.env[ENV_VAR];
  if (env && env.length > 0) return env;

  const configured = settings.defaultRole;
  if (configured && roles.some((r) => r.frontmatter.name === configured)) {
    return configured;
  }

  return BUILTIN_PI_ROLE_NAME;
}

/**
 * Find the most recent `pi-roles:active-role` entry on the active branch.
 * Returns undefined when none exists or when entries can't be enumerated
 * (e.g. session_start hasn't fully bound the session manager yet).
 */
function findRestoredState(
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): ActiveRoleState | undefined {
  let entries;
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return undefined;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === "custom" && e.customType === ACTIVE_ROLE_ENTRY_TYPE) {
      const data = (e.data ?? undefined) as ActiveRoleState | undefined;
      if (data && !data.intent) {
        // The latest apply lost the intent. This happens on sessions resumed
        // by a pre-fix launch (continue used to re-apply with no intent and
        // persist that wipe), but a fresh session that never generated an
        // intent looks identical here. The intent belongs to the session — it
        // is only ever deliberately cleared by `--reset`, which starts a new
        // file — so recovering the most recent intent this session ever had
        // is safe and heals files damaged by the old behavior.
        for (let j = i - 1; j >= 0; j--) {
          const prev = entries[j];
          if (prev && prev.type === "custom" && prev.customType === ACTIVE_ROLE_ENTRY_TYPE) {
            const prevData = (prev.data ?? undefined) as ActiveRoleState | undefined;
            if (prevData?.intent) {
              debugLog("index", "findRestoredState intent fallback", {
                role: data.name,
                recoveredIntent: prevData.intent,
              });
              return { ...data, intent: prevData.intent };
            }
          }
        }
      }
      return data;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Apply wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve a role name + apply it + update in-memory state. Centralized so
 * session_start, /role <name>, and /role reload share identical error
 * handling and warning surfacing.
 */
async function applyResolved(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  state: RuntimeState,
  name: string,
  options: { silent: boolean; preservedIntent: string | undefined },
): Promise<void> {
  let resolved: ResolvedRole;
  try {
    resolved = resolveRole(name, state.roles);
  } catch (err) {
    const message = err instanceof RoleResolutionError ? err.message : String(err);
    debugLog("index", `applyResolved fallback: ${message}`);
    // Fall back to the built-in pi role if the requested role is missing or
    // broken. Surface the underlying error so the user can fix the file.
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-roles: ${message} Falling back to ${BUILTIN_PI_ROLE_NAME}.`, "warning");
    }
    const fallback = findBuiltInRole(state.roles, BUILTIN_PI_ROLE_NAME);
    if (!fallback) {
      // Built-in pi is missing too — bail without changing session state.
      return;
    }
    resolved = resolveRole(BUILTIN_PI_ROLE_NAME, state.roles);
  }

  const result = await applyRole(
    resolved,
    {
      pi,
      ctx,
      warnOnMissingMcp: state.settings.warnOnMissingMcp ?? true,
      intercomMode: state.settings.intercomMode,
      defaultTools: state.baselineTools,
    },
    options,
  );

  state.activeRole = resolved;
  state.intent = result.state.intent;
  state.skillsWarnedKey = null; // fresh role → allow a fresh warning round
  debugLog("index", `applied role=${resolved.name}`, { intent: result.state.intent, warnings: result.warnings });

  if (ctx.hasUI && result.warnings.length > 0 && !options.silent) {
    // The notification message already mentions the warning count; surface
    // the actual text via ui.notify so the user sees what to fix without
    // expanding the message.
    for (const w of result.warnings) ctx.ui.notify(`pi-roles: ${w}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// /role subcommands
// ---------------------------------------------------------------------------

async function handleList(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (state.roles.length === 0) {
    ctx.ui.notify(
      "pi-roles: no roles found. Create one in .pi/roles/ or ~/.pi/agent/roles/.",
      "info",
    );
    return;
  }
  const lines = state.roles
    .slice()
    .sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name))
    .map((r) => {
      const marker = state.activeRole?.name === r.frontmatter.name ? "* " : "  ";
      return `${marker}${r.frontmatter.name} [${r.source}] — ${r.frontmatter.description}`;
    });
  const shadowed = state.shadowed.map(
    (s) => `  ${s.name} [${s.source}] (shadowed) — ${s.path}`,
  );
  const all =
    shadowed.length > 0
      ? ["Available roles:", ...lines, "", "Shadowed (lower-priority duplicates):", ...shadowed]
      : ["Available roles:", ...lines];
  ctx.ui.notify(all.join("\n"), "info");
}

async function handleCurrent(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (!state.activeRole) {
    ctx.ui.notify("pi-roles: no role active.", "info");
    return;
  }
  const r = state.activeRole;
  const chain = r.extendsChain.length > 1 ? ` (extends: ${r.extendsChain.slice(1).join(" → ")})` : "";
  ctx.ui.notify(`pi-roles: ${r.name}${chain} — ${r.description}\n${r.path}`, "info");
}

async function handleReload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  // Disk re-read already happened in the command handler prelude; just
  // re-apply against the freshly discovered set.
  const previous = state.activeRole?.name ?? pickInitialRoleName(pi, state.settings, state.roles);
  await applyResolved(pi, ctx, state, previous, {
    silent: false,
    preservedIntent: state.intent,
  });
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

/**
 * Provide tab completions for `/role <here>`. Combines built-in subcommands
 * with discovered role names; case-insensitive prefix match.
 */
export function roleCompletions(prefix: string, roles: RawRole[]): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  const items: AutocompleteItem[] = [];

  for (const sub of SUBCOMMANDS) {
    if (sub.toLowerCase().startsWith(needle)) {
      items.push({ value: sub, label: sub, description: subcommandDescription(sub) });
    }
  }
  for (const r of roles) {
    if (r.frontmatter.name.toLowerCase().startsWith(needle)) {
      items.push({
        value: r.frontmatter.name,
        label: r.frontmatter.name,
        description: `${r.source} — ${r.frontmatter.description}`,
      });
    }
  }
  return items.length > 0 ? items : null;
}

function subcommandDescription(sub: (typeof SUBCOMMANDS)[number]): string {
  switch (sub) {
    case "list":
      return "Show all available roles.";
    case "current":
      return "Show the active role.";
    case "reload":
      return "Re-read the active role file from disk.";
  }
}
