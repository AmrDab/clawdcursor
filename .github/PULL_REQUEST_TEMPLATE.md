## Summary

<!-- One paragraph: what changes and why. Link any related issues. -->

## Changes

<!-- Bullet list of the substantive changes. File paths welcome. -->

## Test plan

<!-- How did you verify this works? Tick what applies. -->

- [ ] `npm run typecheck` clean
- [ ] `npm run test:ci` passing (759/760 baseline; note any new skips)
- [ ] `npm run test:mcp-schema-snapshot` &mdash; if you touched `src/tools/` or the MCP server, the snapshot diff is intentional and committed
- [ ] Manual smoke on at least one OS (specify which: macOS / Windows / Linux)
- [ ] If touching the MCP surface: verified the tool call you changed works end-to-end through stdio AND HTTP

## Risk / scope

<!-- Anything reviewers should pay extra attention to: cross-OS behavior, schema changes, anything that touches a guarantee in SECURITY.md (Stop, the pause, the AI-host guard, the hard key list, the HTTP token). -->
