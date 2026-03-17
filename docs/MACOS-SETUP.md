# macOS Setup Guide

Complete guide to running Clawd Cursor on macOS. The agent uses **JXA (JavaScript for Automation)** and **System Events** for native UI automation, and **CDP (Chrome DevTools Protocol)** for browser interactions.

---

## ⚠️ Accessibility Permissions (CRITICAL — Read First!)

Clawd Cursor uses the macOS Accessibility API via JXA/System Events. You **must** grant Accessibility permission to the **terminal app** that runs `node`/`npx`:

1. Open **System Settings → Privacy & Security → Accessibility**
2. Click **+** and add your terminal app:
   - **Terminal.app**, **iTerm.app**, **Warp**, **Alacritty**, etc.
3. **Restart your terminal** after granting permission
4. If scripts still fail from `npx` but work manually, also try adding `/usr/bin/osascript`

> **Note:** `sudo` does NOT bypass Accessibility permissions — they are per-app, not per-user.

### Quick verification
```bash
# Should return JSON array of windows:
osascript -l JavaScript scripts/mac/get-windows.jxa

# If this works manually but fails from npx, it's a permissions issue.
```

---

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **macOS**   | 13 (Ventura) | 14+ (Sonoma) |
| **Node.js** | 18.0    | 20+ |
| **Xcode CLI** | Any recent version | Latest |

### Install Node.js

```bash
# Using Homebrew (recommended)
brew install node

# Or download from https://nodejs.org
```

---

## 1. Accessibility Permissions (Required)

Clawd Cursor uses the macOS Accessibility API via `osascript` and System Events. You **must** grant your terminal app Accessibility access.

### Grant Access

1. Open **System Settings** → **Privacy & Security** → **Accessibility**
2. Click the **+** button (you may need to unlock with your password)
3. Add your terminal application:
   - **Terminal.app** (`/Applications/Utilities/Terminal.app`)
   - **iTerm2** (`/Applications/iTerm.app`) — if you use iTerm
   - **VS Code** — if running from VS Code's integrated terminal
   - **Warp** / **Alacritty** / other terminals as applicable
4. Make sure the toggle is **ON** for your terminal

> ⚠️ **"Not authorized to send Apple events"** — If you see this error, your terminal doesn't have Accessibility permission. Follow the steps above to fix it.

### Verify Accessibility Access

```bash
# This should list your foreground windows without errors
osascript -l JavaScript -e '
  var se = Application("System Events");
  se.includeStandardAdditions = true;
  var fp = se.processes.where({frontmost: true})[0];
  JSON.stringify({name: fp.name(), pid: fp.unixId()});
'
```

If it works, you'll see something like: `{"name":"Terminal","pid":12345}`

---

## 2. Install & Build

```bash
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor && npm install && npm run build
```

### Make macOS scripts executable

```bash
chmod +x scripts/mac/*.sh
chmod +x scripts/mac/*.jxa
```

---

## 3. Configure AI Provider

### Free (Ollama — local, no API key)

```bash
# Install Ollama
brew install ollama

# Pull the model
ollama pull qwen2.5:7b

# Run the doctor
npm run doctor -- --provider ollama
```

### Anthropic (recommended for complex tasks)

```bash
echo "AI_API_KEY=sk-ant-api03-..." > .env
npm run doctor
```

### OpenAI

```bash
echo "AI_API_KEY=sk-..." > .env
npm run doctor -- --provider openai
```

---

## 4. Launch with CDP (Browser Automation)

To use the CDPDriver for browser tasks, launch Chrome or Edge with the remote debugging port:

### Google Chrome

```bash
# Launch Chrome with CDP enabled
open -a "Google Chrome" --args --remote-debugging-port=9222

# If Chrome is already running, quit it first:
# osascript -e 'tell application "Google Chrome" to quit'
# Then relaunch with the flag above
```

### Microsoft Edge

```bash
open -a "Microsoft Edge" --args --remote-debugging-port=9222
```

### Verify CDP is working

```bash
curl -s http://localhost:9222/json/version | python3 -m json.tool
```

You should see Chrome/Edge version info. If you get "Connection refused", the browser isn't running with CDP enabled.

---

## 5. Start the Agent

```bash
npm start
```

Or with specific options:

```bash
# With Ollama (free, local)
npm start -- --provider ollama

# With debug screenshots
npm start -- --debug

# Custom port
npm start -- --port 4000
```

### Send a task

```bash
curl http://localhost:3847/task -H "Content-Type: application/json" \
  -d '{"task": "Open Safari and go to google.com"}'
```

---

## How It Works on macOS

### UIDriver (Native App Automation)

The UIDriver uses **JXA (JavaScript for Automation)** scripts via `osascript` to interact with native macOS apps through the Accessibility API:

| Windows (PowerShell/.NET) | macOS (JXA + System Events) |
|---------------------------|------------------------------|
| `find-element.ps1` | `scripts/mac/find-element.sh` → `find-element.jxa` |
| `invoke-element.ps1` | `scripts/mac/interact-element.sh` → `invoke-element.jxa` |
| `interact-element.ps1` | `scripts/mac/interact-element.sh` |
| UI Automation ControlTypes | Accessibility Roles (AXButton, AXTextField, etc.) |
| `InvokePattern.Invoke()` | `element.click()` |
| `ValuePattern.SetValue()` | `element.value = "text"` or `keystroke` |

### CDPDriver (Browser Automation)

The CDPDriver works identically on both platforms — it connects to Chrome/Edge via WebSocket on `localhost:9222`. No platform-specific code needed.

### OS Detection

UIDriver automatically detects the platform:

```typescript
const driver = new UIDriver();
// On macOS: uses scripts/mac/*.sh → JXA
// On Windows: uses scripts/*.ps1 → PowerShell/.NET
// Same API — callers don't need to know which OS
```

---

## Troubleshooting

### "Not authorized to send Apple events"

**Cause:** Your terminal doesn't have Accessibility permissions.

**Fix:** System Settings → Privacy & Security → Accessibility → Add your terminal app.

### "No process found with ID X"

**Cause:** The target app has no accessible windows, or the PID is wrong.

**Fix:**
```bash
# Find the PID of an app
pgrep -f "Google Chrome"

# List all visible windows
osascript -l JavaScript scripts/mac/get-windows.jxa
```

### CDP connection refused

**Cause:** Chrome/Edge wasn't launched with `--remote-debugging-port=9222`.

**Fix:** Quit the browser completely, then relaunch:
```bash
osascript -e 'tell application "Google Chrome" to quit'
sleep 2
open -a "Google Chrome" --args --remote-debugging-port=9222
```

### "osascript: not found"

**Cause:** PATH issue in the shell environment.

**Fix:** `osascript` should be at `/usr/bin/osascript`. Make sure `/usr/bin` is in your PATH:
```bash
echo $PATH | tr ':' '\n' | grep /usr/bin
```

### Scripts not executable

```bash
chmod +x scripts/mac/*.sh scripts/mac/*.jxa
```

### Python3 not found (used by find-element.sh)

The `find-element.sh` script uses Python 3 for JSON transformation. macOS ships with Python 3:
```bash
/usr/bin/python3 --version
```

If missing, install via: `brew install python3` or `xcode-select --install`

---

## Platform Differences

| Feature | Windows | macOS |
|---------|---------|-------|
| UI Automation | .NET UIAutomationClient | System Events + JXA |
| Element IDs | AutomationId (developer-set) | Not available (use name) |
| ControlTypes | `Button`, `Edit`, `MenuItem` | `AXButton`, `AXTextField`, `AXMenuItem` |
| Script runner | PowerShell (`powershell.exe`) | Bash + osascript |
| CDP port | Same (9222) | Same (9222) |
| Shell command chaining | `;` (PowerShell) | `&&` (Bash) |

---

## Quick Reference

```bash
# Run doctor
npm run doctor

# Start agent
npm start

# Start with Ollama (free)
npm start -- --provider ollama

# Launch Chrome with CDP
open -a "Google Chrome" --args --remote-debugging-port=9222

# Test accessibility
osascript -l JavaScript scripts/mac/get-foreground-window.jxa

# List all windows
osascript -l JavaScript scripts/mac/get-windows.jxa

# Find a button
osascript -l JavaScript scripts/mac/find-element.jxa -name "OK" -role "button"

# Get UI tree of frontmost app
bash scripts/mac/get-ui-tree.sh
```
