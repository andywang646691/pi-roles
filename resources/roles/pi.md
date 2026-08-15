---
name: pi
description: Pi's default expert coding agent. The default role when no other role is configured.
---

> **Note:** this markdown body is informational only. At runtime, pi-roles
> substitutes Pi's own default system prompt — the "expert coding assistant"
> prompt built by the installed pi version — in its place, including the live
> tool list, guidelines, pi-docs paths, project context, skills, and working
> directory. This role therefore never drifts from the installed pi.

This role reproduces the out-of-the-box pi experience:

- `/role pi` restores the default behavior after you've switched to another
  role.
- Other roles inherit the default behavior with `extends: pi`.
- Drop your own `pi.md` into `.pi/roles/` (project) or `~/.pi/agent/roles/`
  (user) to override it — your file's body then fully replaces pi's default
  system prompt.
