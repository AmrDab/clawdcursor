# Contributing to Clawd Cursor

Thanks for considering a contribution. Clawd Cursor is a small project with a single maintainer; the goal of this guide is to keep PRs and issues tractable, not to gate-keep.

## Before you start

- **Bugs:** open an issue first if it's not obviously trivial. The bug template is a one-pager — fill it in honestly so we can repro.
- **Features:** open a feature-request issue before writing code. Some ideas (a new compact action, a new platform) need an architectural sketch first to avoid wasted effort.
- **Security issues:** do not open a public issue or PR. Use [GitHub private vulnerability reporting](https://github.com/AmrDab/clawdcursor/security/advisories/new) — see [SECURITY.md](SECURITY.md) for scope and what to include.

## Local development

```sh
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor
npm install
npm run setup              # builds, links the global `clawdcursor` binary, builds native helpers on macOS
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | `tsx watch src/surface/cli.ts` — rebuild on save |
| `npm run typecheck` | `tsc --noEmit` — must be clean |
| `npm run lint` | ESLint over `src/` |
| `npm run test` | `vitest` watch mode |
| `npm run test:ci` | `vitest run` — 759/760 baseline, one intentional skip |
| `npm run test:mcp-schema-snapshot` | Diffs the granular tool catalog against `schema.snapshot.json`. Fails if the schema changed. Commit the new snapshot (`:update`) when the change is intentional. |

CI runs typecheck + lint + tests + schema snapshot on every PR across Windows, macOS, and Linux on Node 20 and 22. Match that locally before pushing where possible.

## Code style

- TypeScript strict mode is on. No `any` unless you have a real reason and a comment explaining it.
- Business logic does not see `process.platform`. Cross-OS branches live in `src/platform/{windows,macos,linux,wayland-backend}.ts` behind the `PlatformAdapter` interface. If you find yourself writing `if (IS_MAC)` outside `src/platform/`, move it.
- clawdcursor does not judge what the agent does; it keeps the guarantees in [SECURITY.md](SECURITY.md). Every synthetic key and click must go through an input layer wrapped by `guardInputMethods` (`src/platform/pointer-guard.ts`): do not add a path to the OS around it. Give a new tool an accurate `safetyTier` (0 = reads only) and say `destructive: false` only if it cannot destroy anything by itself, because MCP hosts build their permission prompts on those annotations.
- New compact tool actions: define them in `src/tools/compact.ts`, then run `npm run test:mcp-schema-snapshot:update` and commit the snapshot diff. The `argRemap` field is how you alias agent-friendly arg names onto granular tools — see the `key`/`combo` example.
- Tests live alongside the modules they cover under `src/__tests__/` (Vitest). Prefer integration tests that hit the real adapter over mocks.

## Contributing a guide (separate repo)

App guides for the marketplace live in [`AmrDab/clawdcursor-guides`](https://github.com/AmrDab/clawdcursor-guides), not here. See that repo's CONTRIBUTING.md for the schema and PR flow. The standalone linter (`scripts/lint-guide.mjs` there) mirrors the client linter in `src/llm/knowledge/guide-linter.ts` — keep them in sync.

## Commit messages

Conventional-commits-ish. Lowercase type, colon, short imperative. Examples:

```
fix(pause): the pause prompt now renders on Wayland
feat(compact): add browser({"action":"page_context"})
docs(readme): correct compact-action enum names
release(0.8.7): two-line summary
```

The "what's new" line in CHANGELOG and SKILL.md gets edited too — small features can usually share a CHANGELOG entry with related work.

## Pull requests

- Use the PR template. The "Test plan" section matters — reviewers should not have to guess what you ran.
- Include CHANGELOG.md and SKILL.md updates in the same PR as the code change. They are part of the surface area.
- Schema snapshot diffs (`schema.snapshot.json`) must be intentional. If your PR shows a snapshot diff you did not expect, something else changed.
- Cross-OS PRs: if you can't test on all three, say so. CI catches most cross-OS regressions but not all (Wayland and TCC permissions need real machines).

## What gets merged

Things I'll merge quickly: bug fixes with a clear repro, doc fixes, small PRs that make existing behavior more correct. Things that take longer to land: new tools (need schema review), changes to a guarantee in SECURITY.md (need threat-model review), anything that adds a top-level dependency.

If you've put work into a PR and it's been sitting more than a week, ping the issue or Discord — I have probably just lost track.
