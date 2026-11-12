# docs/internal/

Maintainer-only design records. Not published as part of the website
(which is served from `docs/`), not linked from the README, not
authoritative once the corresponding feature ships.

Kept in version control so the history of major design decisions is
recoverable, but readers should always defer to:

- The shipped code under `src/`
- The user-facing docs at the parent `docs/` directory
- The [CHANGELOG](../../CHANGELOG.md) for the canonical release-by-release record

## Contents

| File | What it is | Stale? |
|---|---|---|
| `v0.9-design.md` | Pre-implementation design doc for the v0.9 architecture rewrite. Frozen at "draft for review" status — implementation has since landed. | Yes — superseded by the shipped code. |
| `v0.9-readme-building-blocks.md` | Raw material that fed the v0.9 README rewrite. | Yes — what shipped is the README itself. |
| `agnostic-audit-report.md` | App-agnosticism audit from mid-v0.9 development. Some paths and counts reflect mid-development state. | Partially — recommendations were applied; numeric/path details may be stale. |

When a feature ships, the design doc here can be deleted or kept as
history. We default to keeping for now.
