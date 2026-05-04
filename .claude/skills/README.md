# Project-scoped skills — empty by design

This folder is intentionally empty.

A skill earns its place here only when:

1. You've found yourself writing the same prompt to Claude three or more times.
2. A global skill from `~/.claude/skills/` doesn't already cover it.
3. The pattern is specific to this project — not a general-purpose helper.

Likely future candidates:

- `snapshot-sql-builder` — generate query variants from a column-mapping spec.
- `sheets-write-wrapper` — emit the boilerplate around a `spreadsheets.values.append` call (UUID gen, audit log append, error fallthrough).

**Don't preemptively create these.** Skills accumulate maintenance cost; empty folders don't.
