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
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('clawd-cursor')
  .description('🐾 AI Desktop Agent — native screen control')
  .version('0.5.1');

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
   ║       CLAWD CURSOR v0.5.1             ║
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
    const url = `http://127.0.0.1:${opts.port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log('🐾 Clawd Cursor stopped');
      } else {
        console.error('Unexpected response:', JSON.stringify(data));
      }
    } catch {
      console.error('No running instance found');
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
$host.UI.RawUI.WindowTitle = "🐾 Clawd Cursor — Task Console"
Write-Host "🐾 Clawd Cursor — Interactive Task Mode" -ForegroundColor Cyan
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
        const tmpScript = path.join(os.tmpdir(), 'clawd-task-console.ps1');
        fs.writeFileSync(tmpScript, scriptContent);
        spawnExec('powershell.exe', [
          '-Command', `Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','${tmpScript}'`
        ], { detached: true, stdio: 'ignore' } as any);
      } else if (platform === 'darwin') {
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), 'clawd-task-console.sh');
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        spawnExec('open', ['-a', 'Terminal', tmpScript], { detached: true, stdio: 'ignore' } as any);
      } else {
        // Linux fallback
        const fs = await import('fs');
        const path = await import('path');
        const tmpScript = path.join(os.tmpdir(), 'clawd-task-console.sh');
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
  .description('Kill a running Clawd Cursor instance (same as stop)')
  .option('--port <port>', 'API server port', '3847')
  .action(async (opts) => {
    const url = `http://127.0.0.1:${opts.port}/stop`;
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json() as any;
      if (data.stopped) {
        console.log('🐾 Clawd Cursor killed');
      } else {
        console.error('Unexpected response:', JSON.stringify(data));
      }
    } catch {
      console.error('No running instance found');
    }
  });

program.parse();
