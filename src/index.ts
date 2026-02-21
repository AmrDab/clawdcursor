#!/usr/bin/env node

/**
 * 🐾 Clawd Cursor — AI Desktop Agent over VNC
 * 
 * Your AI connects to your desktop like a remote user.
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
  .description('🐾 AI Desktop Agent over VNC')
  .version('0.2.0');

program
  .command('start')
  .description('Start the Clawd Cursor agent')
  .option('--vnc-host <host>', 'VNC server host', 'localhost')
  .option('--vnc-port <port>', 'VNC server port', '5900')
  .option('--vnc-password <pass>', 'VNC server password')
  .option('--port <port>', 'API server port', '3847')
  .option('--provider <provider>', 'AI provider (anthropic|openai)', 'anthropic')
  .option('--model <model>', 'Vision model to use')
  .option('--api-key <key>', 'AI provider API key')
  .action(async (opts) => {
    const config: ClawdConfig = {
      ...DEFAULT_CONFIG,
      vnc: {
        host: opts.vncHost,
        port: parseInt(opts.vncPort),
        password: opts.vncPassword || process.env.VNC_PASSWORD || '',
      },
      server: {
        ...DEFAULT_CONFIG.server,
        port: parseInt(opts.port),
      },
      ai: {
        provider: opts.provider as any,
        apiKey: opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
        model: opts.model || DEFAULT_CONFIG.ai.model,
        visionModel: opts.model || DEFAULT_CONFIG.ai.visionModel,
      },
    };

    console.log(`
🐾 ╔═══════════════════════════════════════╗
   ║         CLAWD CURSOR v0.2.0           ║
   ║   AI Desktop Agent over VNC           ║
   ╚═══════════════════════════════════════╝
`);

    // Connect to VNC
    console.log(`Connecting to VNC at ${config.vnc.host}:${config.vnc.port}...`);
    const agent = new Agent(config);

    try {
      await agent.connect();
    } catch (err) {
      console.error(`\n❌ Failed to connect to VNC server: ${err}`);
      console.error(`\nMake sure a VNC server is running:`);
      console.error(`  1. Install TightVNC: https://tightvnc.com/download.php`);
      console.error(`  2. Start TightVNC Server`);
      console.error(`  3. Set a password when prompted`);
      console.error(`  4. Run: clawd-cursor start --vnc-password <your-password>`);
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
  .command('task <text>')
  .description('Send a task to a running Clawd Cursor instance')
  .option('--port <port>', 'API server port', '3847')
  .action(async (text, opts) => {
    const url = `http://127.0.0.1:${opts.port}/task`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: text }),
      });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error(`Failed to connect to Clawd Cursor at ${url}`);
      console.error('Is the agent running? Start it with: clawd-cursor start');
    }
  });

program.parse();

