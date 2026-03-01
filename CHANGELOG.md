# Changelog

All notable changes to Clawd Cursor will be documented in this file.

## [0.6.5] - 2026-02-28 — Checkpoint System, Task Completion Detection

### Added
- **Checkpoint-based task completion** — Computer Use tracks milestones (compose opened → fields filled → send pressed → compose closed) and stops when all checkpoints are met. No more wasted calls after successful completion.
- **Task type detection** — auto-classifies tasks (email, form, navigate, draw, file_save) and applies appropriate checkpoint templates.
- **Smart early termination** — when Claude says "done" and ≥75% checkpoints confirmed, accepts completion immediately.
- **Auto-config on first run** — `clawdcursor start` auto-detects providers without needing `clawdcursor doctor`.
- **Universal provider support** — any OpenAI-compatible endpoint works via `--base-url`.
- **CLI model selection** — `--text-model` and `--vision-model` flags.

### Fixed
- **Email domain extraction bug** — "send to user@hotmail.com" no longer navigates to hotmail.com. Email addresses are stripped before URL matching.
- **Verification override bug** — verification no longer contradicts confirmed checkpoint completion. Skipped when ≥50% checkpoints met.
- **Context loss between layers** — Computer Use now receives full context of what pre-processing already did.
- **Drawing quality** — minimum 50px drag distances enforced via system prompt.
- **OpenClaw credential discovery** — multi-provider scan, template variable resolution, no false overrides.
- **Pipeline gate** — Action Router always runs, shortcuts work everywhere.

### Changed
- Pipeline pre-processes "open X and Y" tasks — opens app via Action Router (free), then hands remaining task to deeper layers.
- Smart Interaction detects visual loop tasks (draw, paint) and skips to Computer Use.
- Computer Use system prompt includes Snap Assist handling and drawing guidelines.

## [0.6.2] - 2026-02-28 — Universal Provider Support, Auto-Config

### Added
- **Auto-config on first run** — `clawdcursor start` auto-detects and configures providers without needing `clawdcursor doctor` first. Doctor is now optional for fine-tuning.
- **Universal provider support** — any OpenAI-compatible endpoint works. Not limited to 7 hardcoded providers. Use `--base-url` + `--api-key` for custom endpoints.
- **CLI model selection** — `--text-model` and `--vision-model` flags on start command.
- **Dynamic OpenClaw provider mapping** — reads ALL providers from OpenClaw config, not just known ones. NVIDIA, Fireworks, Mistral, etc. work automatically.

### Changed
- `clawdcursor start` now auto-runs setup if no config exists (non-interactive)
- Provider detection accepts any provider name, falling back to OpenAI-compatible API
- `detectProvider()` returns 'generic' for unknown providers instead of defaulting to 'openai'

## [0.6.1] - 2026-02-28 — Keyboard Shortcuts, Pipeline Fixes

### Added
- **Keyboard shortcuts registry** (`src/shortcuts.ts`) — 30+ common actions mapped to direct keystrokes. Scroll, copy, paste, undo, reddit upvote/downvote, browser shortcuts, and more. Zero LLM calls.
- **Fuzzy shortcut matching** — "scroll the page down" fuzzy-matches to scroll-down shortcut. Context-aware matching for social media actions.
- **Router telemetry** — Action Router now logs match type, confidence, and shortcut hits.
- **CDP→UIDriver fallback** — Smart Interaction falls back to accessibility tree automation when browser CDP path fails.
- **Gmail, Outlook, Hotmail** added to Browser Layer site map.

### Fixed
- **Pipeline gate bug** — Action Router was gated behind `!isBrowserTask`, causing shortcuts to be skipped for browser-context tasks (e.g., "reddit upvote" matched browser regex but should use shortcut). Action Router now always runs after Browser Layer.
- **URL extraction false positives** — "open gmail and send email to foo@bar.com" no longer extracts `bar.com`. URL extraction now isolates the navigation clause before matching.
- **Reliable force-stop** — `clawdcursor stop` now force-kills lingering processes via PID file.
- **Provider label inference** — startup logs now clearly show text and vision provider names separately.

### Changed
- Pipeline order: Browser Layer (L0) → Action Router + Shortcuts (L1) → Smart Interaction (L1.5) → A11y Reasoner (L2) → Vision (L3). Action Router no longer gated.
- `extractUrl()` uses navigation clause isolation instead of matching against full task text.

## [0.6.0] - 2026-02-28 — Universal Provider Support, OpenClaw Integration

### Added
- **OpenClaw credential integration** — auto-discovers all configured providers from OpenClaw's `auth-profiles.json` and `openclaw.json`. No separate API key needed when running as an OpenClaw skill.
- **Universal provider support** — added Groq, Together AI, DeepSeek as first-class providers with profiles, env var detection, and key prefix recognition.
- **Auto-detection as default** — provider defaults to `auto` instead of hardcoding Anthropic. Doctor picks the best available provider automatically.
- **Mixed provider pipelines** — use Ollama for text (free) + any cloud provider for vision (best quality). Vision credentials preserved when brain reconfigures for text.
- **Dynamic Ollama model selection** — doctor picks the best available Ollama model instead of hardcoding `qwen2.5:7b`.
- **Anthropic vision routing fix** — detects Anthropic vision by key prefix (`sk-ant-`) independently of the main provider field, so split-provider setups work correctly.

### Changed
- Default config no longer assumes any specific provider or model
- Provider scan loop iterates all registered providers dynamically
- Help text and doctor output are provider-agnostic
- `--provider` CLI flag accepts any string (not limited to 4 providers)
- README updated with 7-provider compatibility table

### Security
- **SKILL.md hardened** — removed aggressive autonomy language ("use without asking", "be independent")
- **Sensitive App Policy** — agents must ask the user before accessing email, banking, messaging, or password managers
- **Safety tiers as hard rules** — 🔴 Confirm actions must never be self-approved by agents
- **Data flow transparency** — expanded security section documents network isolation, per-provider data flow, and Ollama = fully offline
- **No credentials in skill directory** — OpenClaw users get auto-discovery from local config; no keys stored in skill files

### Fixed
- Vision model crash when main provider set to Ollama but vision uses Anthropic (`model not found` error)
- Brain reconfiguration was wiping vision credentials — now preserved

---

## [0.5.6] - 2026-02-27 — Fluid Decomposition, Interactive Doctor, Smart Vision Fallback

### Added
- **Fluid LLM task decomposition** — decompose prompt now tells the LLM to reason about what ANY app needs. No more hardcoded examples. "Write me a sentence about dogs" generates actual content instead of typing the literal instruction.
- **Interactive doctor onboarding** — after scanning providers, doctor shows all working TEXT and VISION LLM options with ★ recommendations. User picks by number, Enter for default. Shows GPU info (VRAM via nvidia-smi) to help decide local vs cloud.
- **Cloud provider guidance** — doctor shows unconfigured providers with signup URLs and lets you paste an API key inline (auto-detects provider, saves to .env).
- **Smart vision fallback for compound tasks** — when Router or Reasoner handles part of a multi-step task but fails midway, ALL remaining subtasks are bundled and handed to Computer Use (vision). Prevents false-success trapping in cheap layers.
- **Ollama auto-detection** — brain auto-reconfigures to use local Ollama for decomposition when no cloud API key is set. `hasApiKey` now recognizes local LLMs.
- **Compound task guard** — action router detects multi-step/compound tasks (commas, "then", "and then") and skips to deeper layers.

### Fixed
- **Case-preserving action router** — all regex matches against raw (unmodified) task text. Typed text and URLs no longer get lowercased.
- **Flexible click matching** — `click Blank document` works without quotes (was requiring `click "Blank document"`). Single unified regex for quoted and unquoted element names.
- **PowerShell encoding** — replaced emoji (🐾) and em dash (—) in task console title that broke on Windows PowerShell due to encoding.
- **Stale config** — `.clawd-config.json` now correctly reflects Ollama when doctor detects it (was stuck on Anthropic).
- **Brain provider mismatch** — decomposition no longer calls Anthropic API when only Ollama is available.

### Changed
- **`npm run setup`** — new script that builds and registers `clawdcursor` as a global command via `npm link`. Works on Windows, macOS, and Linux.
- **Stop/kill port validation** — port input is now sanitized (parseInt + range check 1-65535) to prevent command injection
- **Kill health verification** — kill command now verifies `/health` returns a Clawd Cursor response before force-killing
- **Install instructions updated** — README and docs now use `npm run setup`

### Test Results
| Task | Pipeline Path | Steps | LLM Calls | Time | Result |
|------|--------------|-------|-----------|------|--------|
| Open Notepad | Action Router | 1 | 0 | 1.5s | ✅ |
| Open Notepad + write haiku | Router → Smart Interaction → Computer Use | 6 | 7 | 58.8s | ✅ Verified |
| Open Google Doc in Edge + write sentence | Browser → Computer Use | 17 | 9 | 78.8s | ✅ Verified |

## [0.5.5] - 2026-02-26 — Install/Uninstall, OpenClaw Auto-Registration, Doctor UX

### Added
- **`clawdcursor install`** — one command to set up API key, configure pipeline, and register as OpenClaw skill
- **`clawdcursor uninstall`** — clean removal of all config, data, and OpenClaw skill registration
- **Doctor auto-registers as OpenClaw skill** — symlinks into `~/.openclaw/workspace/skills/clawdcursor`
- **Doctor quick fix commands** — shows exact commands for missing text LLM and vision LLM in summary
- **Dashboard favorites** — star commands to save them, click to re-run, persists across server restarts
- **Credential detection** — warns when starring tasks that contain API keys or passwords
- **OS tabs on website** — Windows/macOS/Linux with auto-detect
- **Post-build help message** — shows all available commands after `npm run build`
- **Dynamic OS detection** — system prompt uses actual OS instead of hardcoded "Windows 11" (thanks @molty)

### Fixed
- **Windows skill detection** — removed `requires.bins` from SKILL.md; OpenClaw's `hasBinary()` doesn't handle Windows PATHEXT (`.exe`/`.cmd`), causing the skill to show as "missing" even when node is installed

### Changed
- **SKILL.md rewritten** — agent identity shift framing, trigger lists, CDP direct path, async polling, error recovery
- **Security hardened** — agents cannot self-approve confirm-tier actions, autonomous use scoped to read-only
- **Privacy language clarified** — explicit per-provider data flow
- **Website Get Started simplified** — 3 lines, commands shown in terminal post-build
- **Anthropic text model updated** — `claude-haiku-4-5` (was `claude-3-5-haiku-20241022`)

## [0.5.4] - 2026-02-25 — SKILL.md Rewrite + Security Hardening

### Changed
- **Privacy language clarified** — explicit per-provider data flow (Ollama = fully local, cloud = data to that API only)
- **Added homepage and source URLs** to skill metadata
- **Removed hard-coded paths** from SKILL.md
- **Security section expanded** — includes localhost bind verification command
- **Security scan addressed** — all flagged documentation gaps resolved

## [0.5.3] - 2026-02-25 — SKILL.md Rewrite for Agent Autonomy

### Changed
- **SKILL.md rewritten** — agents now understand they have full desktop control and stop asking users to do things they can do themselves
- **Agent identity shift framing** — blockquote at top overrides default "I can't do desktop things" behavior
- **"When to Use This" trigger list** — comprehensive decision framework for when to reach for Clawd Cursor
- **Two paths documented** — REST API (port 3847) for full desktop control, CDP Direct (port 9222) for fast browser reads
- **Async flow clarified** — concrete polling pattern agents can follow step-by-step
- **Error recovery table** — 8 common problems with exact solutions
- **Expanded task examples** — cross-app workflows, data extraction, verification scenarios
- **README** — added OpenClaw Integration section

## [0.5.2] - 2026-02-25 — Web Dashboard + Browser Foreground Focus

### Added
- **Web Dashboard** — full single-page UI served at `GET /` (port 3847). Task submission, real-time logs, status indicators, approve/reject for safety confirmations, kill switch. Dark theme, fully responsive, zero external dependencies.
- **`clawdcursor dashboard`** — CLI command to open the dashboard in your default browser
- **`clawdcursor kill`** — CLI command to send a stop signal to the running server
- **`GET /logs`** — API endpoint returning last 200 log entries with timestamps and levels
- **Browser foreground focus** — Playwright navigation now brings Chrome to the front via `page.bringToFront()` + OS-level window activation (PowerShell `SetForegroundWindow` on Windows, `osascript` on macOS). The AI acts like a visible cursor — you see everything it does.
- **Console hook** — `hookConsole()` intercepts all server logs for the dashboard log feed with auto-classification (error/success/warn/info)

### Changed
- **Smart task handoff** — Browser layer no longer uses regex word lists to detect multi-step tasks. Pure navigation ("open youtube") completes in browser layer; anything more complex falls through to SmartInteraction where the LLM plans the steps. No more missed verbs.

### Architecture
```
Layer 0: Browser (Playwright) — navigate + foreground focus
    ↓ more than navigation? → fall through
Layer 1: Action Router — regex patterns, zero LLM calls
    ↓ no match? → fall through
Layer 1.5: Smart Interaction — 1 LLM call plans steps, CDP/UIDriver executes
    ↓ failed? → fall through
Layer 2: Accessibility Reasoner — reads UI tree, cheap LLM
    ↓ failed? → fall through
Layer 3: Screenshot + Vision — full screenshot, Computer Use API
```

## [0.5.1] - 2026-02-23 — HD Screenshots + Focus Stability

### Fixed
- **HD screenshots** — LLM resolution increased from 1024px to 1280px (scale 2x instead of 2.5x). Claude can now reliably identify toolbar icons, buttons, and small UI elements.
- **JPEG quality** — bumped from 55 to 65 for clearer icon identification
- **Window focus stability** — `Win+D` minimizes all windows before task execution, preventing the Clawd terminal from stealing focus from target apps
- **Paint drawing reliability** — pencil tool guidance in system prompt, mandatory checkpoint after tool selection
- **Stale file cleanup** — restored `get-windows.ps1` shim (still referenced by accessibility.ts), removed dead `setup.ps1` and `get-ui-tree.ps1`

### Performance (Paint stickman benchmark)
| Metric | v0.5.0 | v0.5.1 |
|--------|--------|--------|
| Time | ~250s | **55s** |
| API calls | 30 | **6** |
| Success rate | ~50% | ~90% |

## [0.5.0] - 2026-02-23 — Smart Pipeline + Doctor + Batch Execution

### Added
- **`clawd-cursor doctor`** — auto-diagnoses setup, tests models, configures optimal pipeline
- **3-layer pipeline** — Action Router → Accessibility Reasoner → Screenshot fallback
- **Layer 2: Accessibility Reasoner** (`src/a11y-reasoner.ts`) — text-only LLM reads the UI tree, no screenshots needed. Uses cheap models (Haiku, Qwen, GPT-4o-mini).
- **Batch action execution** — Claude returns multiple actions per response (3.6 avg), skipping screenshots between batched actions. Drawing tasks execute 10+ actions in a single API call.
- **Focus hints** — each screenshot includes a FOCUS directive telling Claude where to look, reducing output tokens and decision time
- **Auto-maximize** — apps launched via Action Router are automatically maximized (`Win+Up`) for consistent layout
- **Region capture** — `captureRegionForLLM()` crops screenshots to specific areas (2-30KB vs 58KB full)
- **Checkpoint strategy** — screenshots only after critical state changes (app open, dialog appear), not after every action
- **Multi-provider support** — Anthropic, OpenAI, Ollama (local/free), Kimi. Same codebase, auto-detected.
- **Provider model map** (`src/providers.ts`) — auto-selects cheap/expensive models per provider
- **Self-healing** — doctor falls back if a model is unavailable (e.g., Haiku → Qwen). Circuit breaker disables failing layers at runtime.
- **Streaming LLM responses** — early JSON return saves 1-3s per call
- **Combined accessibility script** (`scripts/get-screen-context.ps1`) — 1 PowerShell spawn instead of 3
- **Benchmark harness** (`test-perf-comparison.ts`)

### Performance
- Screenshots: 120KB → ~80KB, 1280px target (HD for reliable icon identification)
- JPEG quality: 70 → 65
- Delays: 200-1500ms → 50-600ms across the board
- System prompts: ~60% smaller (fewer tokens per call)
- Accessibility tree: filtered to interactive elements only, 3000 char cap
- Taskbar cache: 30s TTL (was queried every call)
- Screen context cache: 500ms → 2s TTL

### Benchmarks

| Task | v0.4 | v0.5 (Ollama, $0) | v0.5 (Anthropic) | v0.5 + Batch |
|------|------|--------|---------|---------|
| Calculator | 43s | 2.6s | 20.1s | — |
| Notepad | 73s | 2.0s | 54.2s | — |
| File Explorer | 53s | 1.9s | 22.1s | — |
| Paint stickman | ~250s (30 calls) | — | ~124s (19 calls) | **101s (11 calls)** |
| GitHub profile | — | — | ~106s (15 calls) | — |

## [0.4.0] - 2026-02-22 — Native Desktop Control

**VNC removed.** Clawd Cursor now controls the desktop natively via @nut-tree-fork/nut-js. No VNC server required.

### Breaking Changes
- `--vnc-host`, `--vnc-port`, `--vnc-password` CLI flags removed
- `VNC_PASSWORD`, `VNC_HOST`, `VNC_PORT` environment variables no longer used
- `rfb2` dependency removed
- `setup.ps1` no longer installs TightVNC

### Added
- `NativeDesktop` class (`src/native-desktop.ts`) — drop-in replacement for VNCClient
- Direct screen capture via @nut-tree-fork/nut-js (~50ms vs ~850ms)
- Direct mouse/keyboard control via OS-level APIs
- Simplified onboarding: `npm install && npm start`

### Performance
- Screenshots: ~850ms → ~50ms (17× faster)
- Connect time: ~200ms → ~38ms (5× faster)
- Simple task (Google Docs sentence): ~120s → ~102s
- Complex task (GitHub → Notepad → save): ~200s → ~156s

### Removed
- VNC server dependency (TightVNC)
- `rfb2` npm package
- VNC-related CLI flags and environment variables
- BGRA→RGBA color swap (nut-js returns RGBA natively)

## [0.3.3] - 2025-03-15

### Bulletproof Headless Setup
- setup.ps1 now completes end-to-end in a single run on fresh systems, even in non-interactive/headless AI agent shells
- Generate random VNC password when `--vnc-password` not provided non-interactively
- Replace `Start-Process -NoNewWindow -Wait` with `-PassThru -WindowStyle Hidden` + try/catch (msiexec crash fix)
- Wrap `Start-Service` in its own try/catch (post-install crash fix)
- Replace all emoji with ASCII tags for cp1252 headless terminal compatibility

## [0.3.1] - 2025-03-10

### SKILL.md Security Hardening
- Added YAML frontmatter, explicit credential declarations, privacy disclosure, and security considerations for ClaWHub publishing.

## [0.3.0] - 2025-03-01

### Performance Optimizations (~70% faster)
- Screenshot hash cache — skips LLM calls when the screen hasn't changed
- Adaptive VNC frame wait — captures in ~200ms instead of fixed 800ms
- Parallel screenshot + accessibility fetch — runs concurrently via Promise.all
- Accessibility context cache — 500ms TTL eliminates redundant PowerShell queries
- Async debug writes — no longer blocks the event loop
- Exponential backoff with jitter — better retry resilience for API calls

## [0.2.0] - 2025-02-21

### 🚀 Major: Anthropic Computer Use API

Clawd Cursor now supports Anthropic's native Computer Use API (`computer_20250124`) as the **primary execution path**. This is a fundamentally different approach — the full task goes directly to Claude with native computer use tools. No decomposition, no routing. Claude sees screenshots, plans, and executes natively.

### Dual Execution Paths

The agent now has two separate code paths selected by provider:

- **Path A — Computer Use API** (`--provider anthropic`): Full task sent to Claude with `computer_20250124` tool. Claude sees the screen, plans multi-step sequences, and executes them natively. Handles complex, multi-app workflows reliably.
- **Path B — Decompose + Action Router** (`--provider openai` / offline): Original approach from v0.1.0. Parse task → subtasks → Action Router (UI Automation, zero LLM) → Vision fallback. Faster and cheaper for simple tasks, works without an API key.

### Added

- **Anthropic Computer Use integration** — native `computer_20250124` tool type with `anthropic-beta: computer-use-2025-01-24` header
- **Adaptive delays** — per-action timing: 1000ms for app launch, 800ms for navigation, 100ms for typing, 300ms default
- **Verification hints** — post-action verification prompts after each Computer Use step
- **Mouse drag** — `mouseDrag`, `mouseDown`, `mouseUp` with smooth interpolation between points
- **Bulletproof system prompt** — planning rules, ctrl+l for URL navigation, recovery strategies for failed actions
- **Display scaling** — automatic resolution scaling to 1280×720 for Computer Use API compatibility
- **Vision model** — `claude-sonnet-4-20250514` for Computer Use path

### Test Results

| Task | Time | API Calls | Result |
|------|------|-----------|--------|
| Google Docs: open Chrome, go to Docs, write a paragraph | 187s | 14 | ✅ All succeeded |
| GitHub: open Chrome, navigate to profile, screenshot | 102s | — | ✅ All succeeded |
| Notepad: open, write haiku, save to desktop | ~180s | — | ✅ File saved correctly |
| Paint: draw a stick figure | ~90s | 16 | ✅ Drawing completed |

### Breaking Changes

- **Provider selection now determines execution path.** `--provider anthropic` uses Computer Use API (Path A). `--provider openai` or no provider uses the original Decompose + Action Router pipeline (Path B). This is a fundamental change in behavior — the same task will execute via completely different code paths depending on the provider.

### Performance Characteristics

| | Path A (Computer Use) | Path B (Action Router) |
|---|---|---|
| Best for | Complex multi-step tasks | Simple single-action tasks |
| Reliability | Very high | Good for supported patterns |
| Speed | ~90–190s for complex tasks | ~2s for simple tasks |
| Cost | Higher (multiple API calls with screenshots) | Lower (1 text call or zero) |
| Offline | No | Yes (for common patterns) |

## [0.1.0] - 2025-01-15

### Initial Release

- Action Router with Windows UI Automation — 80% of common tasks with zero LLM calls
- Vision fallback for complex/unfamiliar UI
- Smart task decomposition (single text-only LLM call)
- Three-tier safety system (Auto / Preview / Confirm)
- REST API and CLI interface
- Windows setup script
