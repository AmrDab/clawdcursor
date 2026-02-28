# OpenClaw + Clawd Cursor Efficiency Recommendations

This guide defines how to make OpenClaw and Clawd Cursor work together without duplicate effort.

## 1) Troubleshooting model: identify the bottleneck first

When automation feels slow or flaky, classify failures into one of four buckets:

1. **Routing problem** - GUI used for work that had a direct API/CLI path.
2. **Planning problem** - task prompt too broad, causing unnecessary UI exploration.
3. **Execution problem** - target app/window not focused, selector ambiguity, confirmation gate waits.
4. **Provider problem** - slow/expensive model used when a cheap text path would suffice.

## 2) Default routing policy (recommended)

Use this precedence for every request:

1. **OpenClaw native capability** (API, local files, shell, existing domain skill)
2. **Browser direct path** (Playwright/CDP)
3. **Clawd Cursor GUI path** (REST `/task`) only for residual UI steps

This prevents Clawd Cursor from re-solving work OpenClaw already solves well.

## 3) Universal task decomposition pattern

For broad user requests, run a 3-phase pattern:

- **Phase A - Plan in OpenClaw**
  - Decompose into API/CLI/browser/GUI subtasks.
  - Mark each subtask with the cheapest valid execution path.
- **Phase B - Execute low-cost subtasks first**
  - API + CLI + browser direct.
- **Phase C - Escalate only unresolved UI operations**
  - Send the exact residual actions to Clawd Cursor.

## 4) Prompting recommendations for better GUI reliability

When you do call Clawd Cursor:

- Include app name + objective + expected final state.
- Avoid vague instructions like "handle this".
- Prefer one atomic GUI objective per request.
- Never include credentials in task text.

Example:

- Weak: `Do the payroll thing in the browser`
- Better: `In the open Chrome tab for ACME Payroll, submit timesheet for Jane Doe for week ending 2026-02-21 and confirm status shows Submitted.`

## 5) Performance recommendations

- Keep Layer 1/2 as default path where possible.
- Reserve vision-heavy Layer 3 for ambiguous/visual-only states.
- Reuse active browser/CDP session instead of reopening tabs.
- Abort and resend with tighter instructions when task status stalls.

## 6) Governance recommendation (no skill overlap)

Define ownership explicitly:

- **OpenClaw owns orchestration** (task breakdown, tool choice, policy)
- **Clawd Cursor owns GUI execution** (desktop/browser interaction when required)

A simple rule of thumb:

> If OpenClaw can complete the subtask confidently without GUI, do not call Clawd Cursor.

## 7) Minimal metrics to track efficiency

Track these to confirm improvement:

- % of subtasks completed without GUI escalation
- Median end-to-end task time
- Mean retries per GUI task
- Vision-token usage per task
- Safety confirmation wait time

Improvement target: more tasks completed through OpenClaw native + browser direct, fewer full GUI escalations.
