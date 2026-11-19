# Agnostic Audit Report

**Worktree commit:** `cb60374` (branched from `main`, not `1305184` as task stated; v0.9.0 has since added the playbook strategy + macOS guide. Findings below describe the code as it exists on this worktree.)
**Auditor:** clawdcursor agnostic-principle audit
**Scope:** `src/`, `scripts/`, `docs/`, top-level

## Methodology

1. Grep'd for direct provider/model identifiers (`isAnthropic`, `claude-*`, `gpt-*`, `kimi-*`, `moonshot`, `llama-*`, etc.) and triaged each match against the "allowed places" list.
2. Grep'd for direct app identifiers (`outlook`, `excel`, `chrome`, `figma`, etc.) and triaged each.
3. Distinguished:
   - **Hard violation** — code branches on app/model name and *changes behavior*.
   - **Soft violation** — comments/docs/prompt-examples reference an app as canonical, but the code path itself is generic.
   - **False positive** — legitimate per the allowed-places list (provider catalog, alias table, playbooks, guides, doctor's smoke test, knowledge loader).

## Default vs. legacy code paths

clawdcursor has *three* agent paths today and they sit on very different agnosticism levels:

| Path | Default? | Status |
|---|---|---|
| **Unified pipeline** (`src/pipeline/`) | Yes, since v0.8.1 — `index.ts:298 agent.enableUnifiedPipeline()` is called unless `--legacy` is passed | Almost fully agnostic. The agent loop, prompt, tools, sense, classifier, decomposer, ranker, knowledge loader are all generic. App-specific behavior lives only in `pipeline/playbooks/*.ts` (explicit) and `pipeline/knowledge/guides/*.json` (data). |
| **v2 pipeline** (`src/v2/`) | No — kept behind `enableV2()` for one-release legacy | Mostly agnostic — comments mention Outlook but the code paths read `APP_ALIASES`. |
| **Legacy v1** (`src/agent.ts::_executeTaskInternal` + `action-router.ts`, `computer-use.ts`, `browser-layer.ts`, `deterministic-flows.ts`, `ai-brain.ts`) | No — only via `--legacy` | **Riddled with hardcoded app/model branches.** Most hard violations below live here. |

This affects severity: a violation in the unified pipeline is far worse than the same violation in the legacy path. Severities below take this into account.

## Model-specific violations

| File | Line | Code | Severity | Recommendation |
|---|---|---|---|---|
| `src/snapshot-builder.ts` | 326–331 | Model-name regex (`/gpt-4o\|claude\|gemini\|k2/i`) determines context-window fallback when `providerProfile.textContextWindow` is missing | **Hard, low-impact** (unified-pipeline reaches here only via the legacy SnapshotBuilder, not via `pipeline/sense/snapshot.ts`) | Delete the regex branch. `providerProfile.textContextWindow` already exists in `PROVIDERS` and the 32k conservative default is fine when missing. If we keep the heuristic, push it into `providers.ts` as `inferContextWindowFromName(name)` so there's one canonical place to edit. |
| `src/ocr-reasoner.ts` | 785–790 | Same regex (`/gpt-4o\|claude\|gemini\|k2/i`) duplicated in OcrReasoner | **Hard, legacy-path only** | Same fix; the duplication is also a red flag. Centralize once in `providers.ts`. |
| `src/ai-brain.ts` | 308–310 | `isAnthropicVision` falls back to `visionModel?.includes('claude') && key.startsWith('sk-ant-')` — branches on model name | **Hard, legacy-path only** | Drop the `visionModel?.includes('claude')` clause. `providerProfile.openaiCompat === false` + `baseUrl.includes('anthropic.com')` already give a clean signal (this is what `pipeline/agent/agent.ts` and `llm-client.ts` use). The `sk-ant-` key prefix is fine — that's just key-format detection, not behavior branching. |
| `src/providers.ts` | 246 | `if (apiKey.startsWith('sk-') && apiKey.length > 60) return 'kimi'` — branches by key length | **False positive** — `detectProvider()` is the provider catalog; key-format detection is its job. No behavior is changed downstream; the result feeds the registry, not control flow. |
| `src/credentials.ts` | 80–92 | `inferProviderFromBaseUrl` checks `url.includes('moonshot')`, `url.includes('anthropic')`, etc. | **False positive** — provider catalog territory. |
| `src/doctor.ts` | 1413 | `provider.reasoningVisionModel && model === provider.visionModel ? {} : { temperature: 0 }` | **False positive** — doctor's smoke test, and the branch is on the provider *flag* `reasoningVisionModel`, not a model name. |
| `src/llm-client.ts` | 80, 956, 395, etc. | `isAnthropic = baseUrl.includes('anthropic.com') && !localhost && !11434` | **False positive** — this is the canonical `_callAnthropic` vs `_callOpenAI` dispatch the audit doc carves out as allowed. URL substring is the cleanest available signal. |
| `src/llm-client.ts` | 203, 229, 442 | Comments name `kimi-k2.5`, `deepseek-reasoner` as examples while the code branches on `providerProfile.reasoningVisionModel` (a flag) | **Soft** — the *flag* is the canonical truth; comments are illustrative. |
| `src/generic-computer-use.ts` | 180, 354, 416 | Comments name Kimi as the provider needing `reasoning_content` continuity; code is generic (preserves `reasoning_content` if present) | **Soft** — generic capability preservation, named-example comment. |
| `src/__tests__/provider-matrix.test.ts` | 65, 79, 188, 208 | Tests assert Kimi-specific behavior (no temperature for `kimi-k2.5`) | **False positive** — provider-matrix tests are *supposed* to be model-specific; they pin the catalog's behavior. |
| `src/pipeline/observability/cost-meter.ts` | 38–60 | Price table keyed on `claude-haiku-4-5`, `gpt-4o-mini`, etc. | **False positive** — cost-meter price table is canonically per-model. |
| `src/agent.ts` | 200–204, 74–79 | `inferProviderLabel`/`isAnthropicEndpoint` use base-URL substring | **False positive** — same as `llm-client.ts`. |

**Net:** 3 hard violations (snapshot-builder, ocr-reasoner, ai-brain) — all in legacy modules. The unified pipeline (`src/pipeline/`) is clean.

## App-specific violations

| File | Line | Code | Severity | Recommendation |
|---|---|---|---|---|
| `src/pipeline/router/webview2.ts` | 15 | `WEBVIEW2_APPS_PATTERN = /\b(olk\|outlook\|teams\|slack\|discord\|spotify\|vscode\|code)\b/i` — settle 4 s before UIA queries on these apps | **Hard, unified-pipeline** | This belongs as a data table, not regex-in-router. Either (a) move the list to a JSON manifest `pipeline/knowledge/webview2-apps.json` so it's editable without rebuild, or (b) infer "webview2-ness" generically by sniffing `--type=renderer` / `.asar` in the process's command-line (see comment in `tools/electron_bridge.ts:35`). (a) is the cheap fix today; (b) is the principled fix. |
| `src/pipeline/safety/layer.ts` | 73 | `SENSITIVE_APPS = /\b(outlook\|olk\|mail\|gmail\|banking\|1password\|...)\b/i` — used at L374 to log "sensitive_app.click" audit event | **Hard, low impact** — the regex is only logged today; no behavior changes. But the file's comment promises it elevates the tier. | If the design wants real tier elevation: drive it from per-app metadata in guides (each guide JSON declares `"sensitive": true`). Then the safety layer reads `guide.sensitive` for the active app instead of an embedded list. |
| `src/pipeline/router/router.ts` | 255 | `const isBrowser = /chrome\|firefox\|edge\|safari\|opera\|brave\|msedge/.test(proc)` — used in URL-nav window-match polling | **Hard, narrow** — hardcoded browser-class list in router business logic. | Add a `browser: true` boolean to each browser row in `APP_ALIASES`. Compute `isBrowser` by looking the process up in the alias table; if no row, treat as non-browser. Keeps the table the single source of truth. |
| `src/tools/electron_bridge.ts` | 64–83 | `KNOWN_APPS` hardcoded fingerprint list (Outlook/Teams/Discord/Slack/VS Code/GitHub Desktop/Notion/Obsidian/Spotify) | **Hard, narrow** — limits which apps can be CDP-bridged. | The fingerprint *should* live in a data file. Move `KNOWN_APPS` to `tools/electron-apps.json` (process names, debug flags, kind). Code stays generic. Add to `APP_ALIASES` an optional `electron: { kind, debugFlag }` field if we want a single source of truth. |
| `src/pipeline/verifier/ground-truth.ts` | 174–192 | Hardcoded keywords for `send_email` task type: `compose|untitled|draft|inbox|sent|mailbox|all mail|messages` | **Hard, soft impact** — these are email-app-keyword heuristics encoded in the verifier. Same code is duplicated in `src/v2/verifier/ground-truth.ts`. | The verifier is *intentionally* task-type aware (`send_email`, `navigate_url`, `open_app`, `type_text`, `search`) but the keyword lists assume English email apps with these UI labels. Pull the keyword lists into a per-task-type JSON `pipeline/verifier/keywords.{lang}.json` so localization + app diversity are data, not code. |
| `src/agent.ts` | 235–254 | `getDefaultBrowser()` hardcodes Chrome/Firefox/Brave/Opera/Arc strings on both macOS and Windows | **Hard, legacy-only** (only called from `_executeTaskInternal`) | Derive from `APP_ALIASES` by filtering rows that are tagged `browser: true` and probing each (`existsSync` for the macOS bundle / Windows ProgId). Each new browser = one row, no code change. |
| `src/agent.ts` | 264–272 | `launchBrowserWithUrl` hardcodes Chrome / Edge exe paths (`C:\Program Files\Google\Chrome\...`) | **Hard, legacy-only** | Move exe paths to `APP_ALIASES.executable` (per-OS list). The alias table already has `executable: string`; extend to `executable: string \| string[]`. Then iterate alias.executable. |
| `src/agent.ts` | 672, 710–713 | `isBrowser = /^(edge\|microsoft edge\|chrome\|...)$/i.test(preprocessed.app)` and `webview2Apps = /outlook\|teams\|.../i`, `heavyApps = /word\|excel\|powerpoint/i` | **Hard, legacy-only** | Reuse `needsWebView2Settle()` from `pipeline/router/webview2.ts` (which itself needs fixing — see above). For "heavyApps" add an `appSize: 'heavy'` field to alias rows. |
| `src/agent.ts` | 880–900 | `APP_HINTS` map of `keyword → macOS app name` (Codex, Cursor, VS Code, Chrome, Safari, Firefox, Slack, Discord, Figma, Spotify, Terminal, iTerm, WezTerm, Finder, Calculator, Notes, Mail, Xcode) | **Hard, legacy-only** — but redundant with `APP_ALIASES` | Replace with: iterate `Object.keys(APP_ALIASES)`, match each against the task, pick the longest matching key, use its `macOSAppName`. Same result, alias-table-driven. |
| `src/agent.ts` | 972–1041 | LLM preprocessor system prompt enumerates apps and example URLs (Edge/Chrome/Firefox/Brave/Safari, Gmail, GitHub, Notion, Codepen, Twitter, Wikipedia, Amazon, Reddit, YouTube…) | **Soft** — these are examples in a prompt. The prompt's job is to teach the model URL-shortcuts; concrete examples are appropriate. *But:* the list is duplicated effort against the alias table and the URL-shortcut table in `browser-layer.ts:435`. Consolidate. |
| `src/agent.ts` | 1271–1289 | "If this is a browser task, ensure browser focus … `browserProcessRe.test(...)` then `edgeWin = windows.find(...)`" | **Hard, legacy-only** | Use `APP_ALIASES` + the proposed `browser: true` flag. |
| `src/action-router.ts` | 41–82 | **A SECOND copy of `APP_ALIASES`** — duplicated from `pipeline/router/aliases.ts` | **Hard duplication** (not strictly "violation" but invites drift) | Delete `action-router.ts`'s copy and `import { APP_ALIASES } from './pipeline/router/aliases'`. Either file's drift will silently break the other. |
| `src/action-router.ts` | 94, 352, 364–382, 595, 600–615 | Hardcoded Chrome/Edge launch paths + WebView2 regex + Edge CDP launcher | **Hard, legacy-only** | Roll into alias-table fields once `action-router.ts` is dead-coded. |
| `src/computer-use.ts` | 585–600 | `appHints` map: chrome/msedge/firefox/outlook/thunderbird/notepad/code/excel/word/explorer/slack/teams/discord/paint | **Hard, legacy-only** — used by Anthropic Computer Use focus-verification | Same fix: replace with `APP_ALIASES` iteration + a `keywords?: string[]` field per alias row. |
| `src/computer-use.ts` | 612–618 | `procAliases` map: outlook→[outlook,olk], etc. — duplicate of `processNames` in alias table | **Hard, legacy-only** | Read from `APP_ALIASES[expectedApp].processNames`. Already exists. |
| `src/computer-use.ts` | 708 | `isEmailTask = /\b(email\|mail\|send\|compose\|outlook\|gmail)\b/i.test(subtask)` followed by Outlook-specific window-title checks | **Hard, legacy-only** | This is what the unified pipeline's playbooks (outlook-send / mac-mail-send) do correctly. Delete the in-CU email-special-case once `--legacy` is gone. |
| `src/computer-use.ts` | 1400–1408 | Another `procAliases` map | **Hard, legacy-only duplicate** | Same fix as 612. |
| `src/browser-layer.ts` | 81, 365, 423 | Browser-class regex in business logic + URL extraction regex listing browsers | **Hard, legacy-only** | Replace with `APP_ALIASES` + `browser: true` flag. |
| `src/browser-layer.ts` | 435–456 | `siteMap` hardcodes 19 URLs (google, gmail, github, youtube, twitter, x, reddit, hackernews, stackoverflow, wikipedia, linkedin, facebook, instagram, twitch, discord, npm, outlook, hotmail) | **Soft / data** — this is a URL-shortcut data table, not behavior. Acceptable as data, but should live in a JSON manifest (`browser-shortcuts.json`) and overlap-check with `pipeline/knowledge/domain-map.ts`. |
| `src/deterministic-flows.ts` | 42–203, 373 | Outlook-specific email flow (`outlookEmailFlow`), Outlook window-title regex, etc. | **Hard, dead code** | `agent.ts` constructs `DeterministicFlows` (line 135) but never invokes it (`grep this.deterministicFlows.` returns nothing). **Delete the whole file.** Replaced by `pipeline/playbooks/outlook-send.ts`. |
| `src/shortcuts.ts` | 187–256 | Outlook/Mail/Thunderbird email shortcuts, Safari-specific shortcuts | **False positive** — `shortcuts.ts` *is* the shortcut catalog. Per-app shortcut entries are legitimate data; they're what the public `shortcuts_list` and `shortcuts_execute` MCP tools surface. The data attaches keywords/contexts ("outlook", "safari") so the LLM can find the right one. Compare to `pipeline/knowledge/guides/*.json` for the same pattern. |
| `src/pipeline/router/aliases.ts` | 37–102 | The canonical `APP_ALIASES` table | **False positive** — explicitly allowed. |
| `src/pipeline/playbooks/*.ts` | various | `outlook-send.ts`, `mac-mail-send.ts`, `find-replace.ts` | **False positives** — explicitly allowed; the design says playbooks ARE app-specific by name. |
| `src/pipeline/knowledge/guides/*.json` | n/a | Outlook, Slack, Gmail guides | **False positives** — explicitly allowed; guides are data. |
| `src/pipeline/knowledge/domain-map.ts` | 21–59 | URL/title → app key (gmail.com → gmail, outlook.office.com → outlook, etc.) | **False positive** — this is the canonical place for URL/title→app inference. Adding an app = one row. |
| `src/tools/shortcuts.ts` | 47, 57, 107, 116 | Tool descriptions mention Reddit/Outlook as examples | **Soft** — example text in tool descriptions. Acceptable. |
| `src/tools/cdp.ts` | 5, 15, 26, 154 | Tool descriptions mention Edge/Chrome by name | **Soft** — CDP is the Chrome DevTools Protocol; naming Chrome/Edge is accurate, not opinionated. |
| `src/tools/orchestration.ts` | 164–186 | `userDataDir = 'clawdcursor-edge'`, hard-coded Edge launcher for CDP, Chrome candidates list | **Hard, narrow** — `cdp_launch_browser` MCP tool launches Edge specifically | The `cdp_launch_browser` tool is *intended* to launch a CDP-capable browser, so naming a specific one is fine, but it should accept a `browser?: 'chrome'\|'edge'\|'auto'` arg and resolve via `APP_ALIASES` with the `browser` flag. |
| `src/v2/verifier/ground-truth.ts` | 174–192 | Duplicate of `src/pipeline/verifier/ground-truth.ts` hard violation | **Hard** | Pick one canonical file and import. |
| `src/v2/agent/tools.ts` | 256 | `open_app` description: `'Open an application by name (e.g. "Safari", "TextEdit", "Calculator").'` | **Soft** — illustrative examples. |
| `src/pipeline/agent/tools.ts` | 458 | Same pattern (Notepad / TextEdit / Safari examples) | **Soft** — illustrative. |
| `src/__tests__/*.ts` | many | Tests use Outlook / VSCode / Chrome / Calculator etc. as concrete inputs | **False positives** — tests need concrete examples. |
| `docs/agent-guide.md`, `docs/app-knowledge.md`, `docs/index.html` | n/a | Marketing copy + app-knowledge guide | **False positives** — docs explaining the design naturally name apps. |

## False positives (intentionally specific)

| File | Why allowed |
|---|---|
| `src/llm/providers.ts` (here: `src/providers.ts`) | Provider catalog — explicitly carved out. |
| `src/llm/client.ts` `_callAnthropic` vs `_callOpenAI` (here: `src/llm-client.ts`) | API-shape dispatch — explicitly carved out. |
| `src/core/router/aliases.ts` (here: `src/pipeline/router/aliases.ts`) | App alias table — explicitly carved out. |
| `src/tools/playbooks/*.ts` (here: `src/pipeline/playbooks/*.ts`) | Explicit per-app playbooks — explicitly carved out. |
| `src/pipeline/knowledge/guides/*.json` | App-knowledge JSON — explicitly carved out. |
| `src/pipeline/knowledge/domain-map.ts` | URL/title → app classifier feeding the loader — same allowed-zone. |
| `src/pipeline/knowledge/loader.ts` | Generic guide loader; named workflows are loaded from JSON. |
| `src/doctor.ts` provider scan + smoke test | Provider-specific calls — explicitly carved out. |
| `src/credentials.ts::inferProviderFromBaseUrl` | Provider scan / detection — same zone. |
| `src/pipeline/observability/cost-meter.ts` | Per-model price table — by definition model-named. |
| `src/__tests__/provider-matrix.test.ts` | Pins per-provider behavior — that's the test's job. |
| `src/shortcuts.ts` | Shortcut catalog — per-app entries are the *data* the system surfaces; analogous to guides JSON. |
| `src/pipeline/sense/rank.ts` (comments name Outlook/Teams/Paint as motivating examples) | Code is purely generic; the comments cite real bugs that motivated the algorithm. Soft, acceptable. |
| `src/v2/platform/windows.ts:811–815, 895` (mentions Outlook in comments) | Comment-only. Code paths key on alias-resolved process names. |
| `src/__tests__/*` test files referencing apps | Tests need fixtures. |
| Docs referencing apps | Docs need concrete examples. |

## Cross-OS app drive test (verification of the question "can `clawdcursor task` drive Outlook, Excel, Calculator, VSCode, Figma identically?")

Walking the unified pipeline (default since v0.8.1):

1. `task("Open Calculator and add 2 plus 3")` →
   - `preprocess()` matches `/^open/` → strategy `router`
   - `router.route()` → `APP_ALIASES['calculator']` resolves to `uwpAppId: Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` → `platformAdapter.launchApp()` succeeds
   - Subsequent "add 2 plus 3" routes to text-agent (blind) with the calculator window's a11y tree
   - **Result: clean, no special-casing.**
2. `task("Open VSCode and run command 'Reload Window'")` →
   - `APP_ALIASES['vscode']` → process `Code`, search-term `Visual Studio Code` → launches
   - `WEBVIEW2_APPS_PATTERN` matches `code` → 4 s settle (**violation #1 hits here — webview2 list is hardcoded**)
   - text-agent handles the rest
   - **Result: works, but the webview2 settle is decided by a hardcoded list, not data.**
3. `task("Send an email in Outlook to bob@example.com")` →
   - `preprocess()` → strategy `blind`
   - Active app is Outlook → `matchPlaybook("send email …", "outlook")` returns `'outlook-send'` (✅ explicit playbook path) — BUT note that `matchPlaybook` is currently *defined but unimported* on this commit. Pre-v0.9 the integration is missing; the text-agent has to discover the choreography from a11y.
   - **Result: in the *future* commit (v0.9.0 1305184 has the wire), Outlook is one playbook call. Right now on this worktree, it's text-agent + guide JSON. Both are still alias-table / guide-table driven; neither is hardcoded.**
4. `task("Type 1+1 in Excel cell A1")` →
   - `APP_ALIASES['excel']` → launches
   - text-agent handles cell entry via a11y
   - **Result: identical to Calculator/VSCode flow.**
5. `task("Open Figma")` →
   - `APP_ALIASES['figma']` → launches
   - No playbook, no guide → pure a11y/vision agent
   - **Result: identical to other apps.**

**Unified-pipeline verdict:** the agent loop *does not* branch on the app name. The five apps above all flow through the same `router → text-agent → vision-agent` ladder. App-specific behavior is data (aliases / guides / playbooks).

The hard violations are mostly in the legacy path (`--legacy`) and in three settle-list files (`webview2.ts`, `safety/layer.ts`, `electron_bridge.ts`). Fixing those three migrates clawdcursor to a fully data-driven app surface where adding a new app is one row.

## Summary

- **9 hard violations in unified-pipeline + always-on code** (webview2.ts, safety/layer.ts, router.ts, electron_bridge.ts, pipeline/verifier/ground-truth.ts, v2/verifier/ground-truth.ts duplicate, snapshot-builder.ts model regex, ocr-reasoner.ts model regex, tools/orchestration.ts Edge launcher) → these are the priority fixes.
- **11 hard violations in `--legacy` / dead-code path** (`agent.ts::_executeTaskInternal`, `action-router.ts` duplicate alias table, `computer-use.ts` app maps + email special-case, `browser-layer.ts` browser regex, `deterministic-flows.ts` Outlook flow, `ai-brain.ts` model-name fallback) → low priority while `--legacy` is still supported; **delete `deterministic-flows.ts` immediately** (already dead).
- **~12 soft violations** (comments and prompt examples naming Outlook/Kimi/etc. without branching behavior). Leave as-is; these are documentation.
- **~18 false positives** confirmed legitimate per the allowed-places list.

### Top 5 most concerning hard violations + concrete fix

1. **`src/pipeline/router/webview2.ts:15` — `WEBVIEW2_APPS_PATTERN` regex.**
   *Concrete fix:* move the app list to `src/pipeline/router/webview2-apps.json` (string array) and have `needsWebView2Settle` import + check. Better: add `webview2: true \| 'electron' \| 'webview2' \| 'chromium-shell'` to each `APP_ALIASES` row. Then `needsWebView2Settle` does `APP_ALIASES[resolveAlias(name)?.key ?? '']?.webview2`. **One row per app, zero code change.**

2. **`src/pipeline/safety/layer.ts:73` — `SENSITIVE_APPS` regex.**
   *Concrete fix:* add `sensitive: true` to relevant rows in `APP_ALIASES` *or* to the guide JSON's top-level. Then `evaluate()` reads it via `resolveAlias(ctx.activeApp)?.sensitive ?? false`. The hardcoded "1password / lastpass / bitwarden" entries become alias rows (they aren't there today). This also fixes the comment-promise mismatch — today the line *only logs* and doesn't elevate the tier.

3. **`src/tools/electron_bridge.ts:64-83` — `KNOWN_APPS` hardcoded fingerprint list.**
   *Concrete fix:* extract to `src/tools/electron-apps.json` (or embed in `APP_ALIASES` via an optional `electron: { kind, debugFlag }` field). Code stays generic and detection becomes data-driven. Pull the long-term plan (process command-line `--type=renderer` / `.asar` sniffing in the file's own comment) into a follow-up.

4. **`src/pipeline/verifier/ground-truth.ts:174-192` (and `src/v2/verifier/ground-truth.ts` duplicate) — hardcoded email-app keywords.**
   *Concrete fix:* extract the task-type keyword lists to `src/pipeline/verifier/keywords.json`:
   ```json
   {
     "send_email": {
       "compose": ["new message", "compose", "untitled", "draft"],
       "inbox":   ["inbox", "sent", "mailbox", "all mail", "messages"]
     },
     "search": { "results": ["\\d+\\s+results?", "showing\\s+\\d+"] }
   }
   ```
   Verifier reads at startup; tests can supply alternative tables. This also opens the door to localization.

5. **`src/snapshot-builder.ts:325-331` + `src/ocr-reasoner.ts:785-790` — duplicated `/gpt-4o|claude|gemini|k2/i` model-name regex.**
   *Concrete fix:* delete both inline regexes; rely on `pipelineConfig.provider?.textContextWindow`. The conservative `32000` fallback is fine when missing. If the heuristic is worth keeping, expose it once in `providers.ts` as `inferContextWindowFromModel(modelName: string): number | null` so there's a single edit point.

### Recommended sequence

| Step | Effort | Outcome |
|---|---|---|
| 1. Delete `src/deterministic-flows.ts` (dead code) | 5 min | Removes 1 hard violation outright. |
| 2. Add `webview2`, `browser`, `sensitive`, `electron`, `keywords` optional fields to `APP_ALIASES` rows | 30 min | All five turn into one-line data edits. |
| 3. Replace `WEBVIEW2_APPS_PATTERN`, `SENSITIVE_APPS`, `isBrowser` regex, `electron_bridge.KNOWN_APPS`, agent.ts `webview2Apps`/`heavyApps`/`APP_HINTS`/`browserProcessRe` with alias-table lookups | 2 h | Removes 8 hard violations. Single source of truth. |
| 4. Extract verifier keyword lists to JSON | 30 min | Removes 2 duplicate hard violations (pipeline + v2). |
| 5. Delete `src/snapshot-builder.ts` and `src/ocr-reasoner.ts` model-name regex; rely on `providerProfile.textContextWindow` | 10 min | Removes 2 hard violations. |
| 6. (Optional) When `--legacy` is removed in v0.9.x: delete `src/action-router.ts`, `src/computer-use.ts`, `src/browser-layer.ts`'s legacy paths, `src/ai-brain.ts` | 1 h | Removes remaining 11 legacy hard violations. |

After steps 1–5, the entire **default** clawdcursor surface (unified pipeline + tools that run regardless of `--legacy`) is fully model-agnostic and app-agnostic — adding a new app or provider is a data edit, not a code edit.
