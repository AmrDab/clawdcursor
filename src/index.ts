#!/usr/bin/env node

/**
 * 🐾 Clawd Cursor — AI Desktop Agent
 *
 * Your AI controls your desktop natively.
 */

import { Command } from 'commander';
import { Agent } from './agent';
import { createServer } from './server';
import { DEFAULT_CONFIG } from './types';
import type { ClawdConfig } from './types';
import { VERSION } from './version';
import dotenv from 'dotenv';
import { resolveApiConfig } from './credentials';
import * as fs from 'fs';
import * as path from 'path';
import { migrateFromLegacyDir } from './paths';

dotenv.config();

// Migrate data from legacy ~/.openclaw/clawdcursor/ to ~/.clawdcursor/
migrateFromLegacyDir();

// ── Auth helper ──────────────────────────────────────────────────────────────
// Reads the saved Bearer token from ~/.clawdcursor/token (written by start/serve).
function loadAuthToken(): string {
  try {
    const tokenPath = path.join(require('os').homedir(), '.clawdcursor', 'token');
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return '';
  }
}
function authHeaders(): Record<string, string> {
  const token = loadAuthToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── Emoji gate (shared utility) ──────────────────────────────────────────────
import { e } from './format';

// ── Single-instance pidfile lock ─────────────────────────────────────────────
// Prevents duplicate start/mcp/serve processes from accumulating (a common
// source of stale processes when Cursor/editors restart the MCP server).

const PID_DIR = path.join(require('os').homedir(), '.clawdcursor');

function pidFilePath(mode: 'start' | 'mcp' | 'serve'): string {
  return path.join(PID_DIR, `${mode}.pid`);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without sending a real signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if another instance is already running for this mode.
 * Returns the stale pid if a live duplicate is found, otherwise null.
 * Writes the current pid to the lockfile on success.
 */
function claimPidFile(mode: 'start' | 'mcp' | 'serve'): number | null {
  try {
    if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });
    const pidFile = pidFilePath(mode);
    if (fs.existsSync(pidFile)) {
      const existing = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(existing) && existing !== process.pid && isProcessAlive(existing)) {
        return existing; // live duplicate found
      }
    }
    fs.writeFileSync(pidFile, String(process.pid), { encoding: 'utf-8', mode: 0o600 });
    return null;
  } catch {
    return null; // non-fatal — lock is best-effort
  }
}

function releasePidFile(mode: 'start' | 'mcp' | 'serve'): void {
  try {
    const pidFile = pidFilePath(mode);
    if (fs.existsSync(pidFile)) {
      const stored = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (stored === process.pid) fs.unlinkSync(pidFile);
    }
  } catch {
    // non-fatal
  }
}

const program = new Command();

async function isClawdInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json() as any;
    return data.status === 'ok' && typeof data.version === 'string';
  } catch {
    return false;
  }
}

async function forceKillPort(port: number): Promise<boolean> {
  const { execSync } = await import('child_process');
  const os = await import('os');

  if (os.platform() === 'win32') {
    try {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8' },
      );
      const pids = new Set(
        output.trim().split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
      );

      if (pids.size === 0) return false;
      for (const pid of pids) {
        execSync(`taskkill /F /PID ${pid}`);
        console.log(`${e('🐾', '>')} Killed process ${pid}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  try {
    execSync(`kill -9 $(lsof -ti tcp:${port})`, { shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

program
  .name('clawdcursor')
  .description('🐾 AI Desktop Agent — native screen control')
  .version(VERSION);

program
  .command('start')
  .description('Start the Clawd Cursor agent')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .option('--model <model>', 'Vision model to use')
  .option('--text-model <model>', 'Text/reasoning model for Layer 2')
  .option('--vision-model <model>', 'Vision model for Layer 3')
  .option('--base-url <url>', 'Custom API base URL (OpenAI-compatible)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .option('--accept', 'Accept desktop control consent non-interactively and start')
  .action(async (opts) => {
    // Single-instance guard
    const existingPid = claimPidFile('start');
    if (existingPid !== null) {
      console.error(`${e('❌', '[ERR]')} clawdcursor start is already running (pid ${existingPid}). Run \`clawdcursor stop\` first.`);
      process.exit(1);
    }

    // Handle consent before anything else
    const { hasConsent, writeConsentFile, runOnboarding } = await import('./onboarding');
    if (opts.accept) {
      writeConsentFile();
      console.log('  Consent recorded.\n');
    } else if (!hasConsent()) {
      const accepted = await runOnboarding('start', parseInt(opts.port, 10) || 3847);
      if (!accepted) process.exit(1);
    }

    // Auto-setup on first run
    const configPath = path.join(__dirname, '..', '.clawdcursor-config.json');
    if (!fs.existsSync(configPath)) {
      console.log(`${e('🔍', '*')} First run — auto-detecting AI providers...\n`);
      const { quickSetup } = await import('./doctor');
      const pipeline = await quickSetup();
      if (pipeline) {
        console.log(`${e('✅', '[OK]')} Auto-configured! Run \`clawdcursor doctor\` to customize.\n`);
      } else {
        console.log(`${e('⚠️', '[WARN]')}  No AI providers found. Layer 1 (Action Router) will still work.`);
        console.log('   Run `clawdcursor doctor` to set up AI providers.\n');
      }
    }

    const resolvedApi = resolveApiConfig({
      apiKey: opts.apiKey,
      provider: opts.provider,
      baseUrl: opts.baseUrl,
    });

    const config: ClawdConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        port: parseInt(opts.port),
      },
      ai: {
        provider: resolvedApi.provider || opts.provider || DEFAULT_CONFIG.ai.provider,
        apiKey: resolvedApi.apiKey,
        baseUrl: opts.baseUrl || resolvedApi.baseUrl,
        textBaseUrl: resolvedApi.textBaseUrl,
        textApiKey: resolvedApi.textApiKey,
        visionBaseUrl: resolvedApi.visionBaseUrl,
        visionApiKey: resolvedApi.visionApiKey,
        model: opts.textModel || resolvedApi.textModel || opts.model || DEFAULT_CONFIG.ai.model,
        visionModel: opts.visionModel || resolvedApi.visionModel || opts.model || DEFAULT_CONFIG.ai.visionModel,
      },
      debug: opts.debug || false,
    };

    console.log(`\x1b[32m\u2713\x1b[0m \x1b[1mclawdcursor\x1b[0m \x1b[90mv${VERSION}\x1b[0m \x1b[90m\u2014 desktop control active on ${config.server.host}:${config.server.port}\x1b[0m`);

    if (resolvedApi.source === 'external') {
      console.log(`${e('🔗', '--')} External credentials detected — pipeline config (.clawdcursor-config.json) takes priority`);
    }

    const agent = new Agent(config);

    try {
      await agent.connect();
    } catch (err) {
      console.error(`\n${e('❌', '[ERR]')} Failed to initialize native desktop control: ${err}`);
      console.error(`\nThis usually means @nut-tree-fork/nut-js couldn't access the screen.`);
      console.error(`Make sure you're running this on a desktop with a display.`);
      process.exit(1);
    }

    // Start API server (agent API + tool API on same port)
    const app = createServer(agent, config);

    // Mount model-agnostic tool server alongside agent API
    // POST /execute/* requires auth; GET /tools and GET /docs are public
    try {
      const { createToolServer } = await import('./tool-server');
      const { requireAuth } = await import('./server');
      const toolCtx = {
        desktop: agent.getDesktop(),
        a11y: (agent as any).a11y,
        cdp: (agent as any).cdpDriver,
        getMouseScaleFactor: () => 1,  // start command uses agent's own scaling
        getScreenshotScaleFactor: () => agent.getDesktop().getScaleFactor(),
        ensureInitialized: async () => {},  // agent already initialized
      };
      app.use('/execute', requireAuth);  // auth gate on all tool execution
      app.use(createToolServer(toolCtx));
    } catch (err) {
      console.warn('Tool server not loaded:', (err as Error).message);
    }

    // Pre-check: is the port already in use?
    const net = await import('net');
    const portFree = await new Promise<boolean>((resolve) => {
      const tester = net.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => { tester.close(); resolve(true); });
      tester.listen(config.server.port, config.server.host);
    });
    if (!portFree) {
      console.error(`\n${e('❌', '[ERR]')} Port ${config.server.port} is already in use.`);
      console.error(`Another clawdcursor instance may be running.`);
      console.error(`Run 'clawdcursor stop' first, or use --port <other_port>`);
      process.exit(1);
    }

    app.listen(config.server.port, config.server.host, async () => {
      // Generate auth token ONLY after port binds successfully
      // This prevents overwriting a valid token when start fails (e.g. EADDRINUSE)
      const { initServerToken } = await import('./server');
      const serverToken = initServerToken();
      const tokenPath = require('path').join(require('os').homedir(), '.clawdcursor', 'token');
      console.log(`\n\x1b[32m${e('🌐', '[NET]')} API server:\x1b[0m http://${config.server.host}:${config.server.port}`);
      console.log(`\x1b[33m${e('🔑', '[KEY]')} Auth token:\x1b[0m ${serverToken}`);
      console.log(`\x1b[90m   (also saved to ${tokenPath})\x1b[0m`);
      console.log(`\nAgent endpoints:`);
      console.log(`  POST /task     — {"task": "Open Chrome and go to github.com"}`);
      console.log(`  GET  /status   — Agent state`);
      console.log(`  POST /abort    — Stop current task`);
      console.log(`\nTool server (model-agnostic):`);
      console.log(`  GET  /tools    — Tool schemas (OpenAI function format)`);
      console.log(`  POST /execute/{name} — Execute any tool`);
      console.log(`  GET  /docs     — Tool documentation`);
      console.log(`\nAll mutating endpoints require: \x1b[36mAuthorization: Bearer <token>\x1b[0m`);

      // Validate API key on startup
      const { loadPipelineConfig } = await import('./doctor');
      const pipelineConfig = loadPipelineConfig();
      if (pipelineConfig && pipelineConfig.layer2.enabled) {
        try {
          const { callTextLLMDirect } = await import('./llm-client');
          await callTextLLMDirect({
            baseUrl: pipelineConfig.layer2.baseUrl,
            model: pipelineConfig.layer2.model,
            apiKey: pipelineConfig.apiKey,
            isAnthropic: !pipelineConfig.provider.openaiCompat,
            messages: [{ role: 'user', content: 'Reply with just the word "ok"' }],
            maxTokens: 5,
            timeoutMs: 10000,
            retries: 0,
          });
          console.log(`${e('✅', '[OK]')} API key validated for ${pipelineConfig.provider.name}`);
        } catch (err: any) {
          if (err.name === 'LLMAuthError') {
            console.error(`${e('❌', '[ERR]')} API key INVALID for ${pipelineConfig.provider.name} (${pipelineConfig.layer2.model})`);
            console.error(`   Get a new key and update your .env or run: clawdcursor doctor`);
            console.error(`   Server will continue running but tasks will fail until the key is fixed.`);
          } else if (err.name === 'LLMBillingError') {
            console.error(`${e('⚠️', '[WARN]')} API credits exhausted for ${pipelineConfig.provider.name}`);
            console.error(`   Add credits or switch providers. Run: clawdcursor doctor`);
          } else {
            console.warn(`${e('⚠️', '[WARN]')} Could not validate API key: ${err.message?.substring(0, 100)}`);
          }
          // Don't exit — let the server run in case user fixes the key
        }
      }

      console.log(`\nReady. ${e('🐾', '')}`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log(`\n${e('👋', '--')} Shutting down...`);
      releasePidFile('start');
      agent.disconnect();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      releasePidFile('start');
      agent.disconnect();
      process.exit(0);
    });
  });

program
  .command('doctor')
  .description('🩺 Diagnose setup and auto-configure the pipeline')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--no-save', 'Don\'t save config to disk')
  .option('--reset', 'Delete saved config and re-detect everything from scratch')
  .action(async (opts) => {
    const { runDoctor } = await import('./doctor');
    const resolvedApi = resolveApiConfig({
      apiKey: opts.apiKey,
      provider: opts.provider,
    });

    if (opts.reset) {
      const configPath = path.join(__dirname, '..', '.clawdcursor-config.json');
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        console.log(`${e('🗑️', '[DEL]')}  Cleared saved config — re-detecting from scratch\n`);
      }
    }

    // Only use explicit CLI flags for single-provider override.
    // Auto-detected external credentials should go through multi-provider scan.
    const isExplicit = !!(opts.apiKey || opts.provider);
    await runDoctor({
      apiKey: isExplicit ? resolvedApi.apiKey : undefined,
      provider: isExplicit ? (resolvedApi.provider || opts.provider) : undefined,
      baseUrl: isExplicit ? resolvedApi.baseUrl : undefined,
      textModel: isExplicit ? resolvedApi.textModel : undefined,
      visionModel: isExplicit ? resolvedApi.visionModel : undefined,
      save: opts.save !== false,
    });
  });

program
  .command('stop')
  .description('Stop a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number');
      process.exit(1);
    }
    const isClawd = await isClawdInstance(port);
    if (!isClawd) {
      console.log(`${e('🐾', '>')} No running instance found on port ` + port);
      return;
    }

    // Abort first so any active task exits quickly before shutdown.
    try {
      await fetch(`http://127.0.0.1:${port}/abort`, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(2000) });
    } catch {
      // Best effort only.
    }

    const url = `http://127.0.0.1:${port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(5000) });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log(`${e('🐾', '>')} Clawd Cursor stopped`);
      } else {
        console.error('Unexpected response:', JSON.stringify(data));
      }
    } catch {
      // fetch may fail because server died mid-response — that's actually success
    }

    // Verify it actually stopped (wait up to 3s)
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        // Still alive — keep waiting
      } catch {
        // Connection refused = dead = success
        console.log(`${e('✅', '[OK]')} Server confirmed stopped`);
        return;
      }
    }
    console.log(`${e('⚠️', '[WARN]')}  Graceful stop did not complete — force killing...`);
    const killed = await forceKillPort(port);
    if (killed) {
      console.log(`${e('🐾', '>')} Clawd Cursor force stopped`);
    } else {
      console.error(`${e('❌', '[ERR]')} Could not force stop process on port ` + port);
    }
  });

program
  .command('task [text]')
  .description('Send a task to a running Clawd Cursor instance (interactive if no text given)')
  .option('--port <port>', 'API server port', '3847')
  .action(async (text, opts) => {
    const url = `http://127.0.0.1:${opts.port}/task`;

    const sendTask = async (taskText: string) => {
      try {
        console.log(`\n${e('🐾', '>')} Sending: ${taskText}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ task: taskText }),
        });
        if (res.status === 401) {
          console.error('Auth failed (401). Token mismatch — run: clawdcursor stop && clawdcursor start');
          return;
        }
        if (!res.ok) {
          console.error(`Server error (${res.status}). Check server logs.`);
          return;
        }
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.error(`Failed to connect to Clawd Cursor at ${url}`);
        console.error('Is the agent running? Start it with: clawdcursor start');
      }
    };

    if (text) {
      // One-shot mode: clawdcursor task "Open Calculator"
      await sendTask(text);
    } else {
      // Interactive mode: spawn a new terminal window
      const os = await import('os');
      const { execFile: spawnExec } = await import('child_process');
      const platform = os.platform();

      const token = loadAuthToken();
      const scriptContent = platform === 'win32'
        ? // Windows: PowerShell script
          `
$host.UI.RawUI.WindowTitle = "Clawd Cursor - Task Console"
Write-Host "Clawd Cursor - Interactive Task Mode" -ForegroundColor Cyan
Write-Host "   Type a task and press Enter. Type 'quit' to exit." -ForegroundColor Gray
Write-Host ""
$headers = @{ "Content-Type" = "application/json"${token ? `; "Authorization" = "Bearer ${token}"` : ''} }
while ($true) {
    $task = Read-Host "Enter task"
    if (-not $task -or $task -eq "quit" -or $task -eq "exit") {
        Write-Host "Bye!"
        break
    }
    # Strip control characters (Ctrl+L, etc.) that break JSON
    $task = $task -replace '[\\x00-\\x1f]', ''
    $task = $task.Trim()
    if (-not $task) { continue }
    Write-Host "> Sending: $task" -ForegroundColor Yellow
    try {
        $jsonBody = @{ task = $task } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Uri http://127.0.0.1:${opts.port}/task -Method POST -Headers $headers -Body $jsonBody
        $response | ConvertTo-Json -Depth 5
    } catch {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 401) {
                Write-Host 'Auth failed (401). Token mismatch. Run: clawdcursor stop then clawdcursor start' -ForegroundColor Red
            } else {
                Write-Host "Server error ($code). Check server logs." -ForegroundColor Red
            }
        } else {
            Write-Host 'Failed to connect. Is clawdcursor start running?' -ForegroundColor Red
        }
    }
    Write-Host ""
}
`
        : // macOS/Linux: bash script
          `
echo "Clawd Cursor - Interactive Task Mode"
echo "   Type a task and press Enter. Type 'quit' to exit."
echo ""
AUTH_HEADER="${token ? `Authorization: Bearer ${token}` : ''}"
while true; do
    printf "Enter task: "
    read task
    if [ -z "$task" ] || [ "$task" = "quit" ] || [ "$task" = "exit" ]; then
        echo "Bye!"
        break
    fi
    echo "> Sending: $task"
    curl -s -X POST http://127.0.0.1:${opts.port}/task -H "Content-Type: application/json"${token ? ' -H "$AUTH_HEADER"' : ''} -d "{\\"task\\": \\"$task\\"}" | python3 -m json.tool 2>/dev/null || echo "Failed to connect. Is clawdcursor start running?"
    echo ""
done
`;

      if (platform === 'win32') {
        // Write temp PS1 and open in new Windows Terminal / PowerShell window
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawdcursor-task-${Date.now()}.ps1`);
        fs.writeFileSync(tmpScript, scriptContent);
        spawnExec('powershell.exe', [
          '-Command', `Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${tmpScript}'`
        ], { detached: true, stdio: 'ignore' } as any);
      } else if (platform === 'darwin') {
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawdcursor-task-${Date.now()}.sh`);
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('open', ['-a', 'Terminal', tmpScript], { detached: true, stdio: 'ignore' } as any);
      } else {
        // Linux fallback
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawdcursor-task-${Date.now()}.sh`);
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('x-terminal-emulator', ['-e', tmpScript], { detached: true, stdio: 'ignore' } as any);
      }

      console.log(`${e('🐾', '>')} Task console opened in a new terminal window.`);
    }
  });

program
  .command('dashboard')
  .description('Open the Clawd Cursor web dashboard in your browser')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const url = `http://127.0.0.1:${opts.port}`;
    console.log(`${e('🐾', '>')} Opening dashboard... Make sure clawdcursor start is running.`);

    const os = await import('os');
    const { exec: execCmd } = await import('child_process');
    const platform = os.platform();

    if (platform === 'win32') {
      execCmd(`start ${url}`);
    } else if (platform === 'darwin') {
      execCmd(`open ${url}`);
    } else {
      execCmd(`xdg-open ${url}`);
    }
  });

program
  .command('kill')
  .description('Force kill a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    // Validate port is numeric to prevent command injection
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number');
      process.exit(1);
    }

    // Verify it's actually a Clawd Cursor instance before killing
    const isClawd = await isClawdInstance(port);
    if (!isClawd) {
      console.log(`${e('🐾', '>')} No running instance found on port ` + port);
      return;
    }

    // Try graceful stop
    try {
      await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(3000) });
    } catch {
      // May fail if server dies mid-response — that's OK
    }

    // Wait and verify it died
    await new Promise(r => setTimeout(r, 1500));

    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      // Still alive — force kill
      console.log(`${e('⚠️', '[WARN]')}  Graceful stop failed — force killing...`);
      const killed = await forceKillPort(port);
      if (killed) {
        console.log(`${e('🐾', '>')} Clawd Cursor force killed`);
      } else {
        console.error('Could not find process to kill');
      }
    } catch {
      // Connection refused = dead = success
      console.log(`${e('🐾', '>')} Clawd Cursor killed`);
    }
  });

program
  .command('install')
  .description('Set up API key, configure pipeline, and auto-detect providers')
  .option('--api-key <key>', 'AI provider API key')
  .option('--provider <provider>', 'AI provider (auto-detected, or specify: anthropic|openai|ollama|kimi|groq|...)')
  .action(async (opts) => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    console.log(`\n${e('🐾', '>')} Installing Clawd Cursor...\n`);

    const clawdRoot = path.resolve(__dirname, '..');

    // 1. Save API key to .env if provided
    if (opts.apiKey) {
      const envPath = path.join(clawdRoot, '.env');
      const envContent = `AI_API_KEY=${opts.apiKey}\n`;
      fs.writeFileSync(envPath, envContent);
      console.log(`   ${e('✅', '[OK]')} API key saved to .env`);
    }

    // 2. Run doctor (auto-configures pipeline)
    const { runDoctor } = await import('./doctor');
    const resolvedApi = resolveApiConfig({
      apiKey: opts.apiKey,
      provider: opts.provider,
    });
    await runDoctor({
      apiKey: resolvedApi.apiKey,
      provider: resolvedApi.provider || opts.provider,
      baseUrl: resolvedApi.baseUrl,
      textModel: resolvedApi.textModel,
      visionModel: resolvedApi.visionModel,
      save: true,
    });

    console.log(`\n${e('🐾', '>')} Installation complete! Run: clawdcursor start`);
  });

program
  .command('uninstall')
  .description('Remove all Clawd Cursor config, data, and skill registrations')
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`\n${e('❌', '[ERR]')}  clawdcursor uninstall requires an interactive terminal.\n`);
      process.exit(1);
    }

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const readline = await import('readline');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n${e('⚠️', '[WARN]')}  This will remove all Clawd Cursor config and data. Continue? (y/N) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    console.log(`\n${e('🗑️', '[DEL]')}  Uninstalling Clawd Cursor...\n`);
    const clawdRoot = path.resolve(__dirname, '..');
    let removed = 0;

    // 1. Remove config files
    const configFiles = [
      path.join(clawdRoot, '.clawdcursor-config.json'),
      path.join(clawdRoot, '.clawdcursor-favorites.json'),
      path.join(clawdRoot, '.env'),
    ];
    for (const f of configFiles) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`   ${e('🗑️', '[DEL]')}  Removed ${path.basename(f)}`);
        removed++;
      }
    }

    // 2. Remove debug folder
    const debugDir = path.join(clawdRoot, 'debug');
    if (fs.existsSync(debugDir)) {
      fs.rmSync(debugDir, { recursive: true, force: true });
      console.log(`   ${e('🗑️', '[DEL]')}  Removed debug/`);
      removed++;
    }

    // 3. Remove external skill registrations (OpenClaw, Codex, etc.)
    const homeDir = os.homedir();
    const skillPaths = [
      path.join(homeDir, '.openclaw', 'workspace', 'skills', 'clawdcursor'),
      path.join(homeDir, '.openclaw-dev', 'workspace', 'skills', 'clawdcursor'),
      path.join(homeDir, '.openclaw', 'skills', 'clawdcursor'),
      path.join(homeDir, '.codex', 'skills', 'clawdcursor'),
    ];
    for (const sp of skillPaths) {
      if (fs.existsSync(sp)) {
        const stat = fs.lstatSync(sp);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(sp);
        } else {
          fs.rmSync(sp, { recursive: true, force: true });
        }
        console.log(`   ${e('🗑️', '[DEL]')}  Removed skill registration: ${sp}`);
        removed++;
      }
    }

    // 4. Remove dist folder
    const distDir = path.join(clawdRoot, 'dist');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
      console.log(`   ${e('🗑️', '[DEL]')}  Removed dist/`);
      removed++;
    }

    if (removed === 0) {
      console.log('   Nothing to clean up.');
    }

    console.log(`\n${e('🐾', '>')} Uninstalled. To fully remove, delete the clawdcursor folder:`);
    console.log(`   ${clawdRoot}\n`);
  });

// ── Shared subsystem initialization (used by mcp + serve) ──

async function createToolContext() {
  const { NativeDesktop } = await import('./native-desktop');
  const { AccessibilityBridge } = await import('./accessibility');
  const { CDPDriver } = await import('./cdp-driver');
  const { DEFAULT_CONFIG } = await import('./types');

  const desktop = new NativeDesktop({ ...DEFAULT_CONFIG });
  const a11y = new AccessibilityBridge();
  const cdp = new CDPDriver(9223);

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let mouseScaleFactor = 1;
  let screenshotScaleFactor = 1;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await desktop.connect();
      screenshotScaleFactor = desktop.getScaleFactor();
      try {
        const { execFileSync } = await import('child_process');
        const result = execFileSync('powershell.exe', [
          '-NoProfile', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \"$($s.Width),$($s.Height)\"",
        ], { timeout: 10000, encoding: 'utf-8' }).trim();
        const [logicalW] = result.split(',').map(Number);
        if (logicalW > 0) mouseScaleFactor = logicalW / 1280;
      } catch {
        mouseScaleFactor = screenshotScaleFactor;
      }
      await a11y.warmup();
      initialized = true;
      console.log('Subsystems initialized');
    })();
    return initPromise;
  };

  return {
    desktop, a11y, cdp,
    getMouseScaleFactor: () => mouseScaleFactor,
    getScreenshotScaleFactor: () => screenshotScaleFactor,
    ensureInitialized,
  };
}

// ── MCP Mode (for Claude Code, Cursor, Windsurf, Zed, etc.) ──

program
  .command('mcp')
  .description('Run as MCP tool server over stdio (for Claude Code, Cursor, Windsurf, Zed)')
  .action(async () => {
    // Single-instance guard (MCP servers can accumulate when editors restart them)
    const existingMcpPid = claimPidFile('mcp');
    if (existingMcpPid !== null) {
      process.stderr.write(`[ERROR] clawdcursor mcp is already running (pid ${existingMcpPid}). Kill it first.\n`);
      process.exit(1);
    }

    // MCP mode: stdout is protocol, logs go to stderr
    const stderrWrite = (prefix: string, args: any[]) =>
      process.stderr.write(`${prefix}${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
    console.log = (...args: any[]) => stderrWrite('', args);
    console.warn = (...args: any[]) => stderrWrite('[WARN] ', args);
    console.error = (...args: any[]) => stderrWrite('[ERROR] ', args);

    // Consent gate — must be accepted before MCP tools become active
    const { hasConsent } = await import('./onboarding');
    if (!hasConsent()) {
      process.stderr.write(
        `\nERROR: clawdcursor requires one-time consent before use.\n` +
        `This tool gives AI models full control of your desktop.\n\n` +
        `Run one of the following, then retry:\n` +
        `  clawdcursor consent          # interactive consent prompt\n` +
        `  clawdcursor consent --accept # non-interactive (CI/scripts)\n` +
        `  clawdcursor start            # consent + start agent\n\n`
      );
      process.exit(1);
    }

    console.log('clawdcursor MCP mode starting...');

    const { getAllTools } = await import('./tools');
    const ctx = await createToolContext();

    // Dynamic import MCP SDK (ESM package from CJS)
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js' as any);
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js' as any);
    const { z } = await import('zod');

    const server = new McpServer({ name: 'clawdcursor', version: '0.7.1' });

    // Register all tools from the unified registry
    const tools = getAllTools();
    for (const tool of tools) {
      // Convert parameters to Zod schema
      const zodParams: Record<string, any> = {};
      for (const [key, def] of Object.entries(tool.parameters)) {
        let schema: any;
        if (def.type === 'number') schema = z.number();
        else if (def.type === 'boolean') schema = z.boolean();
        else schema = z.string();
        if (def.enum) schema = z.enum(def.enum as [string, ...string[]]);
        schema = schema.describe(def.description);
        if (def.required === false) schema = schema.optional();
        zodParams[key] = schema;
      }

      server.tool(
        tool.name,
        tool.description,
        Object.keys(zodParams).length > 0 ? zodParams : undefined as any,
        async (params: any) => {
          const result = await tool.handler(params, ctx);
          const content: any[] = [];
          if (result.image) {
            content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
          }
          content.push({ type: 'text', text: result.text });
          return { content, isError: result.isError };
        },
      );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log(`clawdcursor MCP ready — ${tools.length} tools registered`);

    ctx.ensureInitialized().catch((err: any) => {
      console.error('Subsystem init failed:', err?.message);
    });

    // Release pidfile on exit so a fresh restart can claim it immediately
    const releaseMcp = () => { releasePidFile('mcp'); process.exit(0); };
    process.on('SIGINT', releaseMcp);
    process.on('SIGTERM', releaseMcp);
  });

// ── Tool Server (model-agnostic, no LLM needed) ──

program
  .command('serve')
  .description('Start the tool server only (no autonomous agent, no LLM). Any AI model can connect via HTTP.')
  .option('--port <port>', 'HTTP server port', '3847')
  .option('--skip-consent', 'Skip consent prompt (requires NODE_ENV=development)')
  .action(async (opts) => {
    // Single-instance guard
    const existingServePid = claimPidFile('serve');
    if (existingServePid !== null) {
      console.error(`${e('❌', '[ERR]')} clawdcursor serve is already running (pid ${existingServePid}). Run \`clawdcursor stop\` first.`);
      process.exit(1);
    }

    const { runOnboarding, hasConsent } = await import('./onboarding');

    // First-run consent — --skip-consent only works in development mode
    const canSkip = opts.skipConsent && process.env.NODE_ENV === 'development';
    if (!canSkip && !hasConsent()) {
      const accepted = await runOnboarding();
      if (!accepted) process.exit(1);
    }

    const port = parseInt(opts.port);
    const express = (await import('express')).default;
    const { createToolServer } = await import('./tool-server');
    const { VERSION } = await import('./version');
    const { randomBytes } = await import('crypto');
    const os = await import('os');

    // Generate auth token (same pattern as start mode)
    const tokenDir = path.join(os.homedir(), '.clawdcursor');
    if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
    const serveToken = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(tokenDir, 'token'), serveToken, { encoding: 'utf-8', mode: 0o600 });

    console.log(`\n${e('🐾', '>')} clawdcursor v${VERSION} — Tool Server mode`);
    console.log('   No LLM. No autonomous agent. Just OS primitives over HTTP.\n');

    const ctx = await createToolContext();

    // Create HTTP server with tool routes
    const app = express();
    app.use(express.json());

    // Auth middleware — require Bearer token on mutating (non-GET) endpoints
    app.use((req: any, res: any, next: any) => {
      if (req.method === 'GET') return next(); // GET /tools, /docs, /health are read-only
      const authHeader = req.headers['authorization'] || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!bearer || bearer !== serveToken) {
        return res.status(401).json({ error: 'Unauthorized — include Authorization: Bearer <token> header. Token is at ~/.clawdcursor/token' });
      }
      next();
    });

    app.use(createToolServer(ctx));

    app.listen(port, '127.0.0.1', () => {
      console.log(`   Tool server: http://127.0.0.1:${port}`);
      console.log(`   Tool schemas: http://127.0.0.1:${port}/tools`);
      console.log(`   Documentation: http://127.0.0.1:${port}/docs`);
      console.log(`   Execute: POST http://127.0.0.1:${port}/execute/{tool_name}`);
      console.log(`\n   ${e('🔑', '[KEY]')} Auth token: ${serveToken}`);
      console.log(`   (saved to ~/.clawdcursor/token)`);
      console.log(`   All POST endpoints require: Authorization: Bearer <token>`);
      console.log(`\n   Ready. Connect your AI model.\n`);
    });

    // Background init
    ctx.ensureInitialized().catch((err: any) => {
      console.error('Subsystem init failed:', err?.message);
    });

    process.on('SIGINT', () => {
      console.log('\n   Shutting down...');
      releasePidFile('serve');
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      releasePidFile('serve');
      process.exit(0);
    });
  });

program
  .command('report')
  .description('Send an error report to help improve clawdcursor. Shows a preview before sending.')
  .option('--log <path>', 'Path to a specific task log file')
  .option('--note <text>', 'Add a note describing what went wrong')
  .option('--save-only', 'Save report locally without sending')
  .action(async (opts) => {
    const { interactiveReport, buildReport, saveReportLocally, submitReport } = await import('./report');

    if (!process.stdin.isTTY) {
      // Non-interactive: build and submit directly
      const report = buildReport(opts.log, opts.note);
      if (opts.saveOnly) {
        const p = saveReportLocally(report);
        console.log(`Report saved: ${p}`);
      } else {
        const result = await submitReport(report);
        if (result.success) {
          console.log(`Report sent. ID: ${result.reportId}`);
        } else {
          const p = saveReportLocally(report);
          console.log(`Send failed: ${result.error}. Saved locally: ${p}`);
        }
      }
      return;
    }

    // Interactive mode
    await interactiveReport();
  });

// ── Consent management ──────────────────────────────────────────────────────
program
  .command('consent')
  .description('Manage desktop control consent (required before MCP/REST use)')
  .option('--accept', 'Accept consent non-interactively (CI/scripted environments)')
  .option('--revoke', 'Remove stored consent')
  .option('--status', 'Show current consent status')
  .action(async (opts) => {
    const { hasConsent, writeConsentFile, revokeConsent, runOnboarding } = await import('./onboarding');

    if (opts.status) {
      if (hasConsent()) {
        console.log(`${e('✅', '[OK]')}  Consent: accepted — clawdcursor is authorized to control this desktop.`);
      } else {
        console.log(`${e('❌', '[ERR]')}  Consent: not given — run \`clawdcursor consent\` to authorize.`);
      }
      return;
    }

    if (opts.revoke) {
      revokeConsent();
      console.log('  Consent revoked. clawdcursor will require re-authorization before next use.');
      return;
    }

    if (opts.accept) {
      writeConsentFile();
      console.log('  Consent accepted. clawdcursor can now control your desktop.');
      console.log('  Run `clawdcursor start` or `clawdcursor mcp` to begin.\n');
      return;
    }

    // Interactive flow
    const accepted = await runOnboarding('consent');
    if (accepted) {
      console.log('  Run `clawdcursor start` or `clawdcursor mcp` to begin.\n');
    } else {
      process.exit(1);
    }
  });

program.parse();
