# session-identity Specification

## Purpose
How pi-roles composes and surfaces the session's visible identity — the footer status, the session name for intercom targeting, and the title bar — in a single canonical ordering `<intent> - <role>`, without overriding Pi's native first-prompt title logic.

## Requirements
### Requirement: Canonical session identity format

The session identity string — used for the title bar (via `pi.setSessionName`), the footer status bar (via `ctx.ui.setStatus`), and the intercom addendum (via `pi.getSessionName`) — SHALL follow the format `<intent> - <role>` where:
- `intent` is the generated session-intent summary.
- `role` is the active role's `name` field.
- The separator is a single ASCII hyphen surrounded by single spaces (` - `).

When no intent has been generated, pi-roles SHALL NOT write a placeholder session name. The session name SHALL be cleared (empty string) so Pi's native title logic — showing the first user prompt — remains in effect until a real intent is generated.

#### Scenario: Footer before first user message
- **WHEN** a session starts with role `architect` and no intent has been generated
- **THEN** the footer status shows `"architect"` (role only — never `"Intent not defined"`)

#### Scenario: Footer after title generation
- **WHEN** a session starts with role `architect` and title generation produces intent `"Design auth schema"`
- **THEN** the footer status shows `"Design auth schema - architect"`

#### Scenario: Session name before first user message
- **WHEN** a session starts with role `planner` and no intent has been generated
- **THEN** `pi.setSessionName` is called with `""` (explicit clear), restoring Pi's native first-prompt title

#### Scenario: Session name after title generation
- **WHEN** a session starts with role `planner` and title generation produces intent `"Plan database migration"`
- **THEN** `pi.setSessionName` is called with `"Plan database migration - planner"`

#### Scenario: Mid-session role swap preserves intent
- **WHEN** the active role is `architect` with intent `"Design auth schema"` and the user runs `/role planner`
- **THEN** `pi.setSessionName` is called with `"Design auth schema - planner"` (intent carried forward, role swapped)

#### Scenario: Title model failure never pins the title
- **WHEN** a session starts with role `architect`, title generation fails (upstream outage, missing credentials), and the user sends prompts
- **THEN** the session name stays cleared and the TUI title bar shows Pi's native first-prompt display instead of `"Intent not defined - architect"`

#### Scenario: Intercom addendum receives stable identity from first turn
- **WHEN** `composeSystemPrompt` runs on the first turn of a session with role `architect` and intercom mode `both`
- **THEN** the intercom addendum embeds the live session name if one exists, otherwise falls back to `"(unnamed session)"` (never a fake placeholder)

---

### Requirement: Footer refreshes synchronously with session name after title generation

When `generateAndApplyTitle` successfully generates an intent, it SHALL update both `pi.setSessionName` and `ctx.ui.setStatus` so the footer reflects the new intent immediately, without waiting for the next `before_agent_start` cycle.

#### Scenario: Footer updates after title generation
- **WHEN** the first user message is `"fix the login bug"` and title generation completes with intent `"Fix login bug"`
- **THEN** both `pi.setSessionName("Fix login bug - architect")` and `ctx.ui.setStatus(STATUS_KEY, "Fix login bug - architect")` are called before `generateAndApplyTitle` returns

---

### Requirement: composeSessionName returns undefined without an intent

`composeSessionName(intent, roleName)` SHALL return the canonical `<intent> - <role>` string when intent is non-empty, and `undefined` when intent is empty, whitespace-only, or absent. It SHALL NOT substitute a placeholder string.

#### Scenario: No intent
- **WHEN** `composeSessionName("architect", undefined)`, `composeSessionName("architect", "")`, or `composeSessionName("architect", "   ")` are called
- **THEN** each returns `undefined`

#### Scenario: Real intent
- **WHEN** `composeSessionName("architect", "Design widget")` is called
- **THEN** it returns `"Design widget - architect"`

---

### Requirement: composeFooterStatus helper

A new exported function `composeFooterStatus(roleName: string, intent: string | undefined): string` SHALL return the canonical `<intent> - <role>` string when intent is non-empty, and the bare role name when intent is empty or whitespace-only.

#### Scenario: Footer status with undefined intent
- **WHEN** `composeFooterStatus("architect", undefined)` is called
- **THEN** it returns `"architect"`

#### Scenario: Footer status with empty string intent
- **WHEN** `composeFooterStatus("architect", "")` is called
- **THEN** it returns `"architect"`

#### Scenario: Footer status with whitespace-only intent
- **WHEN** `composeFooterStatus("architect", "   ")` is called
- **THEN** it returns `"architect"`

#### Scenario: Footer status with real intent
- **WHEN** `composeFooterStatus("architect", "Design widget")` is called
- **THEN** it returns `"Design widget - architect"`