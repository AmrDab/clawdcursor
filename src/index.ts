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

dotenv.config();

const program = new Command();

program
  .name('clawd-cursor')
  .description('🐾 AI Desktop Agent — native screen control')
  .version(VERSION);

program
  .command('start')
  .description('Start the Clawd Cursor agent')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (anthropic|openai|ollama|kimi)', 'anthropic')
  .option('--model <model>', 'Vision model to use')
  .option('--api-key <key>', 'AI provider API key')
  .option('--debug', 'Save screenshots to debug/ folder (off by default)')
  .action(async (opts) => {
    const config: ClawdConfig = {
      ...DEFAULT_CONFIG,
      server: {
        ...DEFAULT_CONFIG.server,
        port: parseInt(opts.port),
      },
      ai: {
        provider: opts.provider as any,
        apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
        model: opts.model || DEFAULT_CONFIG.ai.model,
        visionModel: opts.model || DEFAULT_CONFIG.ai.visionModel,
      },
      debug: opts.debug || false,
    };

    console.log(`
🐾 ╔═══════════════════════════════════════╗
   ║       CLAWD CURSOR v${VERSION}             ║
   ║   AI Desktop Agent — Smart Pipeline   ║
   ╚═══════════════════════════════════════╝
`);

    const agent = new Agent(config);

    try {
      await agent.connect();
    } catch (err) {
      console.error(`\n❌ Failed to initialize native desktop control: ${err}`);
      console.error(`\nThis usually means @nut-tree-fork/nut-js couldn't access the screen.`);
      console.error(`Make sure you're running this on a desktop with a display.`);
      process.exit(1);
    }

    // Start API server
    const app = createServer(agent, config);
    app.listen(config.server.port, config.server.host, () => {
      console.log(`\n🌐 API server: http://${config.server.host}:${config.server.port}`);
      console.log(`\nEndpoints:`);
      console.log(`  POST /task     — {"task": "Open Chrome and go to github.com"}`);
      console.log(`  GET  /status   — Agent state`);
      console.log(`  POST /confirm  — {"approved": true|false}`);
      console.log(`  POST /abort    — Stop current task`);
      console.log(`\nReady. Send a task to get started! 🐾`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down...');
      agent.disconnect();
      process.exit(0);
    });
  });

program
  .command('doctor')
  .description('🩺 Diagnose setup and auto-configure the pipeline')
  .option('--provider <provider>', 'AI provider (anthropic|openai|ollama|kimi)')
  .option('--api-key <key>', 'AI provider API key')
  .option('--no-save', 'Don\'t save config to disk')
  .action(async (opts) => {
    const { runDoctor } = await import('./doctor');
    await runDoctor({
      apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
      provider: opts.provider,
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
    const url = `http://127.0.0.1:${port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log('🐾 Clawd Cursor stopped');
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
        console.log('✅ Server confirmed stopped');
        return;
      }
    }
    console.error('⚠️  Server may still be running — try: clawdcursor kill');
  });

program
  .command('task [text]')
  .description('Send a task to a running Clawd Cursor instance (interactive if no text given)')
  .option('--port <port>', 'API server port', '3847')
  .action(async (text, opts) => {
    const url = `http://127.0.0.1:${opts.port}/task`;

    const sendTask = async (taskText: string) => {
      try {
        console.log(`\n🐾 Sending: ${taskText}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: taskText }),
        });
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

      const scriptContent = platform === 'win32'
        ? // Windows: PowerShell script
          `
$host.UI.RawUI.WindowTitle = "Clawd Cursor - Task Console"
Write-Host "Clawd Cursor - Interactive Task Mode" -ForegroundColor Cyan
Write-Host "   Type a task and press Enter. Type 'quit' to exit." -ForegroundColor Gray
Write-Host ""
while ($true) {
    $task = Read-Host "Enter task"
    if (-not $task -or $task -eq "quit" -or $task -eq "exit") {
        Write-Host "👋 Bye!"
        break
    }
    Write-Host "🐾 Sending: $task" -ForegroundColor Yellow
    try {
        $response = Invoke-RestMethod -Uri http://127.0.0.1:${opts.port}/task -Method POST -ContentType "application/json" -Body ('{"task": "' + $task.Replace('"', '\\"') + '"}')
        $response | ConvertTo-Json -Depth 5
    } catch {
        Write-Host "Failed to connect. Is clawdcursor start running?" -ForegroundColor Red
    }
    Write-Host ""
}
`
        : // macOS/Linux: bash script
          `
echo "🐾 Clawd Cursor — Interactive Task Mode"
echo "   Type a task and press Enter. Type 'quit' to exit."
echo ""
while true; do
    printf "Enter task: "
    read task
    if [ -z "$task" ] || [ "$task" = "quit" ] || [ "$task" = "exit" ]; then
        echo "👋 Bye!"
        break
    fi
    echo "🐾 Sending: $task"
    curl -s -X POST http://127.0.0.1:${opts.port}/task -H "Content-Type: application/json" -d "{\\"task\\": \\"$task\\"}" | python3 -m json.tool 2>/dev/null || echo "Failed to connect. Is clawdcursor start running?"
    echo ""
done
`;

      if (platform === 'win32') {
        // Write temp PS1 and open in new Windows Terminal / PowerShell window
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawd-task-${Date.now()}.ps1`);
        fs.writeFileSync(tmpScript, scriptContent);
        spawnExec('powershell.exe', [
          '-Command', `Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${tmpScript}'`
        ], { detached: true, stdio: 'ignore' } as any);
      } else if (platform === 'darwin') {
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawd-task-${Date.now()}.sh`);
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('open', ['-a', 'Terminal', tmpScript], { detached: true, stdio: 'ignore' } as any);
      } else {
        // Linux fallback
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), `clawd-task-${Date.now()}.sh`);
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('x-terminal-emulator', ['-e', tmpScript], { detached: true, stdio: 'ignore' } as any);
      }

      console.log('🐾 Task console opened in a new terminal window.');
    }
  });

program
  .command('dashboard')
  .description('Open the Clawd Cursor web dashboard in your browser')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const url = `http://127.0.0.1:${opts.port}`;
    console.log('🐾 Opening dashboard... Make sure clawdcursor start is running.');

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
    let isClawd = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json() as any;
      isClawd = data.status === 'ok' && typeof data.version === 'string';
    } catch {
      console.log('🐾 No running instance found on port ' + port);
      return;
    }

    if (!isClawd) {
      console.error('⚠️  Port ' + port + ' is in use but not by Clawd Cursor — aborting');
      return;
    }

    // Try graceful stop
    try {
      await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    } catch {
      // May fail if server dies mid-response — that's OK
    }

    // Wait and verify it died
    await new Promise(r => setTimeout(r, 1500));

    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      // Still alive — force kill
      console.log('⚠️  Graceful stop failed — force killing...');
      const { execSync } = await import('child_process');
      const os = await import('os');
      if (os.platform() === 'win32') {
        try {
          const output = execSync(
            `netstat -ano | findstr :${port} | findstr LISTENING`,
            { encoding: 'utf-8' },
          );
          // Parse all PIDs from netstat output, deduplicate
          const pids = new Set(
            output.trim().split('\n')
              .map(line => line.trim().split(/\s+/).pop())
              .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
          );
          for (const pid of pids) {
            execSync(`taskkill /F /PID ${pid}`);
            console.log(`🐾 Killed process ${pid}`);
          }
        } catch { console.error('Could not find process to kill'); }
      } else {
        try {
          execSync(`kill -9 $(lsof -ti tcp:${port})`, { shell: '/bin/sh' });
          console.log('🐾 Clawd Cursor force killed');
        } catch { console.error('Could not find process to kill'); }
      }
    } catch {
      // Connection refused = dead = success
      console.log('🐾 Clawd Cursor killed');
    }
  });

program
  .command('install')
  .description('Register Clawd Cursor as an OpenClaw skill and save config')
  .option('--api-key <key>', 'AI provider API key')
  .option('--provider <provider>', 'AI provider (anthropic|openai|ollama|kimi)')
  .action(async (opts) => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    console.log('\n🐾 Installing Clawd Cursor...\n');

    const clawdRoot = path.resolve(__dirname, '..');

    // 1. Save API key to .env if provided
    if (opts.apiKey) {
      const envPath = path.join(clawdRoot, '.env');
      const envContent = `AI_API_KEY=${opts.apiKey}\n`;
      fs.writeFileSync(envPath, envContent);
      console.log('   ✅ API key saved to .env');
    }

    // 2. Run doctor (auto-configures pipeline + registers OpenClaw skill)
    const { runDoctor } = await import('./doctor');
    await runDoctor({
      apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
      provider: opts.provider,
      save: true,
    });

    console.log('\n🐾 Installation complete! Run: clawdcursor start');
  });

program
  .command('uninstall')
  .description('Remove all Clawd Cursor config, data, and OpenClaw skill registration')
  .action(async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const readline = await import('readline');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('\n⚠️  This will remove all Clawd Cursor config and data. Continue? (y/N) ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    console.log('\n🗑️  Uninstalling Clawd Cursor...\n');
    const clawdRoot = path.resolve(__dirname, '..');
    let removed = 0;

    // 1. Remove config files
    const configFiles = [
      path.join(clawdRoot, '.clawd-config.json'),
      path.join(clawdRoot, '.clawd-favorites.json'),
      path.join(clawdRoot, '.env'),
    ];
    for (const f of configFiles) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`   🗑️  Removed ${path.basename(f)}`);
        removed++;
      }
    }

    // 2. Remove debug folder
    const debugDir = path.join(clawdRoot, 'debug');
    if (fs.existsSync(debugDir)) {
      fs.rmSync(debugDir, { recursive: true, force: true });
      console.log('   🗑️  Removed debug/');
      removed++;
    }

    // 3. Remove OpenClaw skill registration
    const homeDir = os.homedir();
    const skillPaths = [
      path.join(homeDir, '.openclaw', 'workspace', 'skills', 'clawdcursor'),
      path.join(homeDir, '.openclaw-dev', 'workspace', 'skills', 'clawdcursor'),
    ];
    for (const sp of skillPaths) {
      if (fs.existsSync(sp)) {
        const stat = fs.lstatSync(sp);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(sp);
        } else {
          fs.rmSync(sp, { recursive: true, force: true });
        }
        console.log(`   🗑️  Removed OpenClaw skill: ${sp}`);
        removed++;
      }
    }

    // 4. Remove dist folder
    const distDir = path.join(clawdRoot, 'dist');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
      console.log('   🗑️  Removed dist/');
      removed++;
    }

    if (removed === 0) {
      console.log('   Nothing to clean up.');
    }

    console.log(`\n🐾 Uninstalled. To fully remove, delete the clawd-cursor folder:`);
    console.log(`   ${clawdRoot}\n`);
  });

program.parse();
