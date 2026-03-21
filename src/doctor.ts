/**
 * 🩺 Clawd Cursor Doctor - diagnoses setup and auto-configures the pipeline.
 *
 * Phases:
 * 1. Screen capture test (nut-js)
 * 2. Accessibility bridge test (PowerShell / osascript)
 * 3. AI provider scan — all providers in parallel
 * 4. Model verification — text: instruction-following, vision: real image input
 * 5. Smoke test — a11y→LLM round-trip (reads active window, confirms via model)
 * 6. Interactive pipeline selection
 * 7. Save config
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';
import {
  PROVIDERS,
  PROVIDER_ENV_VARS,
  detectProvider,
  buildPipeline,
  scanProviders,
  buildMixedPipeline,
} from './providers';
import type {
  PipelineConfig,
  ProviderProfile,
  ProviderScanResult,
  ModelTestResult,
} from './providers';
import { DEFAULT_CONFIG } from './types';
import { resolveApiConfig } from './credentials';
import { callVisionLLMDirect } from './llm-client';

const CONFIG_FILE = '.clawdcursor-config.json';
const execFileAsync = promisify(execFile);

interface DiagResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

/**
 * Quick, non-interactive setup for first run auto-configuration.
 * Tests discovered providers with short timeouts and builds the best pipeline.
 * Returns null if no providers work.
 */
export async function quickSetup(): Promise<PipelineConfig | null> {
  console.log('🔍 Scanning available AI providers...');

  // 1. Scan providers (reuse existing logic)
  const scanResults = await scanProviders();
  const anyAvailable = scanResults.some(s => s.available);

  if (!anyAvailable) {
    console.log('⚠️  No AI providers detected. Layer 1 (Action Router) will still work.');
    return null;
  }

  // 2. Quick test available providers (with shorter timeout for first run)
  console.log('⚡ Quick-testing discovered models...');
  const modelTests = await quickTestAllProviders(scanResults);

  const workingText = modelTests.filter(t => t.role === 'text' && t.ok);
  const workingVision = modelTests.filter(t => t.role === 'vision' && t.ok);

  if (workingText.length === 0 && workingVision.length === 0) {
    console.log('⚠️  No working models found. Layer 1 (Action Router) will still work.');
    return null;
  }

  // 3. Build best pipeline automatically
  const pipeline = buildMixedPipeline(scanResults, modelTests);

  // 4. Save to .clawdcursor-config.json
  savePipelineConfig(pipeline, scanResults);

  // 5. Return pipeline
  return pipeline;
}

/**
 * Quick version of testAllProviders with 5s timeout per provider for auto-setup.
 */
async function quickTestAllProviders(scanResults: ProviderScanResult[]): Promise<ModelTestResult[]> {
  const promises: Promise<ModelTestResult>[] = [];

  for (const scan of scanResults) {
    if (!scan.available) continue;

    const provider = PROVIDERS[scan.key];
    if (!provider) continue;

    // ── Text model test ──────────────────────────────────────────
    if (scan.key === 'ollama') {
      const ollamaTextModel = pickOllamaTextModel(scan.ollamaModels || []);
      if (ollamaTextModel) {
        promises.push(
          quickTestModelAsync(provider, scan.apiKey, ollamaTextModel, 'text', scan.key),
        );
      }
    } else {
      promises.push(
        quickTestModelAsync(provider, scan.apiKey, provider.textModel, 'text', scan.key),
      );
    }

    // ── Vision model test ────────────────────────────────────────
    if (scan.key === 'ollama') {
      const ollamaVisionModels = scan.ollamaVisionModels || [];
      if (ollamaVisionModels.length > 0) {
        promises.push(
          quickTestModelAsync(provider, scan.apiKey, ollamaVisionModels[0], 'vision', scan.key),
        );
      }
    } else {
      promises.push(
        quickTestModelAsync(provider, scan.apiKey, provider.visionModel, 'vision', scan.key),
      );
    }
  }

  const settled = await Promise.allSettled(promises);
  const testResults: ModelTestResult[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      testResults.push(result.value);
    }
  }

  return testResults;
}

/**
 * Quick model test with 5s timeout for auto-setup.
 */
async function quickTestModelAsync(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
  role: 'text' | 'vision',
  providerKey: string,
): Promise<ModelTestResult> {
  const result = await quickTestModel(provider, apiKey, model, role === 'vision');
  return {
    providerKey,
    model,
    role,
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

/**
 * Quick model test with 5s timeout — uses real tests for both text and vision.
 */
async function quickTestModel(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
  isVision: boolean,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (isVision) {
    return testVisionModel(provider, apiKey, model);
  }
  return testTextModel(provider, apiKey, model);
}

export async function runDoctor(opts: {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  save?: boolean;
}): Promise<PipelineConfig | null> {
  // Doctor is interactive-only. If stdin is not a TTY (e.g. run in background,
  // piped, or via a script), exit immediately instead of hanging forever waiting
  // for user input that will never come.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      '\n❌  clawdcursor doctor requires an interactive terminal.\n' +
      '    Open a terminal window and run: clawdcursor doctor\n' +
      '    Do NOT run it in the background, piped, or from a script.\n'
    );
    process.exit(1);
  }

  const results: DiagResult[] = [];

  console.log(`\n🩺 Clawd Cursor Doctor - diagnosing your setup...\n`);

  // ─── 0. Version Check ───────────────────────────────────────────
  console.log('📦 Version check...');
  await checkForUpdates(results);

  // ─── 1. Screen Capture ───────────────────────────────────────────
  console.log('📸 Screen capture...');
  const config = { ...DEFAULT_CONFIG };
  const desktop = new NativeDesktop(config);
  try {
    const start = performance.now();
    await desktop.connect();
    const frame = await desktop.captureForLLM();
    const ms = Math.round(performance.now() - start);
    const size = desktop.getScreenSize();
    results.push({
      name: 'Screen capture',
      ok: true,
      detail: `${size.width}x${size.height}, ${(frame.buffer.length / 1024).toFixed(0)}KB, ${ms}ms`,
      latencyMs: ms,
    });
    console.log(`   ✅ ${size.width}x${size.height}, ${ms}ms`);
    desktop.disconnect();
  } catch (err) {
    results.push({ name: 'Screen capture', ok: false, detail: String(err) });
    console.log(`   ❌ ${err}`);
    desktop.disconnect();
  }

  // ─── 1b. macOS Permissions (Screen Recording + Accessibility) ───
  if (process.platform === 'darwin') {
    console.log('🍎 macOS permissions...');
    // Screen Recording: try to capture — if it fails with "not permitted" TCC denied it
    try {
      const { execFileAsync } = await import('child_process').then(m => ({
        execFileAsync: require('util').promisify(m.execFile) as (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      }));
      // osascript can query Accessibility permission
      const { stdout: axOut } = await execFileAsync('osascript', [
        '-e', 'tell application "System Events" to return (UI elements enabled as string)',
      ]).catch(() => ({ stdout: 'false', stderr: '' }));
      const axOk = axOut.trim() === 'true';
      results.push({
        name: 'macOS Accessibility permission',
        ok: axOk,
        detail: axOk
          ? 'Granted — clawdcursor can read UI elements'
          : 'DENIED — open System Settings → Privacy & Security → Accessibility → enable Terminal/Node',
      });
      if (axOk) {
        console.log('   ✅ Accessibility permission granted');
      } else {
        console.log('   ❌ Accessibility permission DENIED');
        console.log('   → System Settings → Privacy & Security → Accessibility → enable your terminal');
      }
    } catch {
      results.push({ name: 'macOS Accessibility permission', ok: false, detail: 'Could not query — run manually in a terminal' });
    }

    // Screen Recording: attempt a screencapture dry run
    try {
      const { execFileAsync } = await import('child_process').then(m => ({
        execFileAsync: require('util').promisify(m.execFile) as (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
      }));
      const tmpFile = `/tmp/.clawdcursor-scrtest-${Date.now()}.png`;
      const { stderr } = await execFileAsync('screencapture', ['-x', '-t', 'png', tmpFile])
        .catch(e => ({ stdout: '', stderr: String(e) }));
      const denied = stderr.toLowerCase().includes('not permitted') || stderr.toLowerCase().includes('permission');
      try { require('fs').unlinkSync(tmpFile); } catch { /* cleanup */ }
      results.push({
        name: 'macOS Screen Recording permission',
        ok: !denied,
        detail: denied
          ? 'DENIED — open System Settings → Privacy & Security → Screen Recording → enable Terminal/Node'
          : 'Granted — clawdcursor can capture the screen',
      });
      if (denied) {
        console.log('   ❌ Screen Recording permission DENIED');
        console.log('   → System Settings → Privacy & Security → Screen Recording → enable your terminal');
      } else {
        console.log('   ✅ Screen Recording permission granted');
      }
    } catch {
      results.push({ name: 'macOS Screen Recording permission', ok: false, detail: 'Could not verify — check manually' });
    }
  }

  // ─── 2. Accessibility Bridge ─────────────────────────────────────
  console.log('♿ Accessibility bridge...');
  const a11y = new AccessibilityBridge();
  try {
    const start = performance.now();
    const available = await a11y.isShellAvailable();
    if (available) {
      const windows = await a11y.getWindows(true);
      const ms = Math.round(performance.now() - start);
      results.push({
        name: 'Accessibility bridge',
        ok: true,
        detail: `${windows.length} windows detected, ${ms}ms`,
        latencyMs: ms,
      });
      console.log(`   ✅ ${windows.length} windows detected, ${ms}ms`);
    } else {
      results.push({ name: 'Accessibility bridge', ok: false, detail: 'Shell not available' });
      console.log(`   ❌ Shell not available`);
    }
  } catch (err) {
    results.push({ name: 'Accessibility bridge', ok: false, detail: String(err) });
    console.log(`   ❌ ${err}`);
  }

  // ─── 3. AI Providers — Multi-Provider Scan ──────────────────────
  // If --provider and --api-key are explicitly given, use the legacy single-provider path
  if (opts.apiKey && (opts.provider || opts.baseUrl || opts.textModel || opts.visionModel)) {
    return runSingleProviderFlow(opts, results);
  }

  // Otherwise scan ALL providers in parallel
  console.log(`\n🔍 Scanning providers...`);
  const scanResults = await scanProviders();

  // If --api-key is given without --provider, inject it into scan results
  if (opts.apiKey) {
    const detectedKey = detectProvider(opts.apiKey, opts.provider);
    const existing = scanResults.find(s => s.key === detectedKey);
    if (existing) {
      existing.available = true;
      existing.apiKey = opts.apiKey;
      existing.detail = `key provided via CLI (${opts.apiKey.substring(0, 8)}...)`;
    }
  }

  // Print scan results
  for (const scan of scanResults) {
    const icon = scan.available ? '✅' : '❌';
    const padded = (scan.name + ':').padEnd(20);
    console.log(`   ${padded} ${icon} ${scan.detail}`);
  }

  // Show unavailable cloud providers with setup instructions
  const unavailableCloud = scanResults.filter(s => !s.available && s.key !== 'ollama');
  if (unavailableCloud.length > 0) {
    console.log(`\n   💡 Cloud providers not configured (add API keys to unlock):`);
    const keyInfo: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY — https://console.anthropic.com (vision + computer use)',
      openai: 'OPENAI_API_KEY — https://platform.openai.com (GPT-4o vision)',
      kimi: 'MOONSHOT_API_KEY — https://platform.moonshot.cn (256k context)',
      groq: 'GROQ_API_KEY — https://console.groq.com (fast inference)',
      together: 'TOGETHER_API_KEY — https://api.together.xyz (open models)',
      deepseek: 'DEEPSEEK_API_KEY — https://platform.deepseek.com (reasoning)',
      gemini: 'GEMINI_API_KEY — https://aistudio.google.com (Gemini Flash/Pro)',
      mistral: 'MISTRAL_API_KEY — https://console.mistral.ai (Pixtral vision)',
      xai: 'XAI_API_KEY — https://console.x.ai (Grok vision)',
      alibaba: 'DASHSCOPE_API_KEY — https://dashscope.console.aliyun.com (Qwen)',
      fireworks: 'FIREWORKS_API_KEY — https://fireworks.ai (fast open models)',
      cohere: 'COHERE_API_KEY — https://dashboard.cohere.com (Command R)',
      perplexity: 'PERPLEXITY_API_KEY — https://www.perplexity.ai (online search)',
    };
    for (const scan of unavailableCloud) {
      if (keyInfo[scan.key]) {
        console.log(`      ${scan.name}: set ${keyInfo[scan.key]}`);
      }
    }
    console.log(`      Set in .env file or as environment variable, then re-run: clawdcursor doctor`);

    // Offer to add a provider interactively
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rlSetup = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string) => new Promise<string>(resolve => rlSetup.question(q, resolve));

      // Step 1: Pick a provider
      const providerList = [
        { key: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY' },
        { key: 'openai',    label: 'OpenAI (GPT-4o)',    envVar: 'OPENAI_API_KEY' },
        { key: 'kimi',      label: 'Kimi / Moonshot',    envVar: 'MOONSHOT_API_KEY' },
        { key: 'gemini',    label: 'Google Gemini',       envVar: 'GEMINI_API_KEY' },
        { key: 'groq',      label: 'Groq',               envVar: 'GROQ_API_KEY' },
        { key: 'deepseek',  label: 'DeepSeek',            envVar: 'DEEPSEEK_API_KEY' },
        { key: 'together',  label: 'Together AI',         envVar: 'TOGETHER_API_KEY' },
        { key: 'mistral',   label: 'Mistral AI',          envVar: 'MISTRAL_API_KEY' },
        { key: 'xai',       label: 'xAI (Grok)',          envVar: 'XAI_API_KEY' },
        { key: 'alibaba',   label: 'Alibaba (Qwen)',      envVar: 'DASHSCOPE_API_KEY' },
        { key: 'fireworks', label: 'Fireworks AI',         envVar: 'FIREWORKS_API_KEY' },
        { key: 'cohere',    label: 'Cohere',              envVar: 'COHERE_API_KEY' },
        { key: 'perplexity',label: 'Perplexity',          envVar: 'PERPLEXITY_API_KEY' },
      ];

      console.log('\n   Select a provider to configure (or Enter to skip):\n');
      for (let i = 0; i < providerList.length; i++) {
        const p = providerList[i];
        const existing = scanResults.find(s => s.key === p.key);
        const status = existing?.available ? ' ✅ (key found)' : '';
        console.log(`      ${String(i + 1).padStart(2)}. ${p.label}${status}`);
      }

      const choice = await ask('\n   Enter number (1-13) or press Enter to skip: ');
      const choiceNum = parseInt(choice.trim());

      if (choiceNum >= 1 && choiceNum <= providerList.length) {
        const selected = providerList[choiceNum - 1];
        console.log(`\n   Selected: ${selected.label}`);

        // Step 2: Paste the key
        const keyInput = await ask(`   🔑 Paste your ${selected.label} API key: `);
        const trimmedKey = keyInput.trim();

        if (trimmedKey) {
          const matchingScan = scanResults.find(s => s.key === selected.key);
          if (matchingScan) {
            matchingScan.available = true;
            matchingScan.apiKey = trimmedKey;
            matchingScan.detail = `key added (${trimmedKey.substring(0, 8)}...)`;
          }

          // Save to .env
          const envPath = path.join(process.cwd(), '.env');
          const envLine = `${selected.envVar}=${trimmedKey}\n`;
          try {
            fs.appendFileSync(envPath, envLine);
            console.log(`   💾 Saved to .env as ${selected.envVar}`);
          } catch {
            console.log(`   ⚠️ Could not save to .env — set ${selected.envVar}=${trimmedKey} manually`);
          }
          console.log(`   ✅ ${selected.label} configured! Testing...`);
        }
      }

      rlSetup.close();
    }
  }

  const anyAvailable = scanResults.some(s => s.available);

  if (!anyAvailable) {
    // Nothing available at all — show setup instructions
    printNoProvidersHelp(results);
    return buildMixedPipeline(scanResults, []);
  }

  // ─── 4. Test discovered providers ───────────────────────────────
  console.log(`\n   Testing models...`);
  const modelTests = await testAllProviders(scanResults);

  // Print test results
  for (const test of modelTests) {
    const icon = test.ok ? '✅' : '❌';
    const providerName = PROVIDERS[test.providerKey]?.name || test.providerKey;
    const latency = test.latencyMs ? `${test.latencyMs}ms` : test.error || 'failed';
    console.log(`   ${test.role === 'text' ? 'Text:  ' : 'Vision:'} ${test.model} (${providerName}) ${icon} ${latency}`);
  }

  const workingText = modelTests.filter(t => t.role === 'text' && t.ok);
  const workingVision = modelTests.filter(t => t.role === 'vision' && t.ok);

  if (workingText.length > 0) {
    results.push({
      name: 'Text model',
      ok: true,
      detail: workingText.map(t => `${t.model} via ${t.providerKey}`).join(', '),
    });
  } else {
    results.push({ name: 'Text model', ok: false, detail: 'No working text model found' });
  }

  if (workingVision.length > 0) {
    results.push({
      name: 'Vision model',
      ok: true,
      detail: workingVision.map(t => `${t.model} via ${t.providerKey}`).join(', '),
    });
  } else {
    results.push({ name: 'Vision model', ok: false, detail: 'No working vision model found' });
  }

  // ─── 5. Smoke Test — end-to-end pipeline sanity ─────────────
  if (workingText.length > 0) {
    console.log(`\n🧪 Smoke test...`);
    const bestText = workingText[0];
    const smokeProvider = PROVIDERS[bestText.providerKey];
    const smokeScan = scanResults.find(s => s.key === bestText.providerKey);
    const smokeKey = smokeScan?.apiKey || '';

    // Quick round-trip: read active window title via a11y, ask LLM to echo it
    let smokeOk = false;
    try {
      const smokeA11y = new AccessibilityBridge();
      const activeWin = await smokeA11y.getActiveWindow();
      const windowTitle = activeWin?.title || 'Terminal';

      // Send window title to text model, ask it to confirm
      const smokeInstruction = `The active window is titled "${windowTitle}". Reply with exactly: SMOKE_PASS`;

      let smokeText = '';
      if (smokeProvider.openaiCompat) {
        const res = await fetch(`${smokeProvider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...smokeProvider.authHeader(smokeKey) },
          body: JSON.stringify({ model: bestText.model, max_tokens: 15, temperature: 0, messages: [{ role: 'user', content: smokeInstruction }] }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json() as any;
        smokeText = data.choices?.[0]?.message?.content || '';
      } else {
        const res = await fetch(`${smokeProvider.baseUrl}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...smokeProvider.authHeader(smokeKey), ...smokeProvider.extraHeaders },
          body: JSON.stringify({ model: bestText.model, max_tokens: 15, messages: [{ role: 'user', content: smokeInstruction }] }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json() as any;
        smokeText = data.content?.[0]?.text || '';
      }

      smokeOk = smokeText.includes('SMOKE_PASS');
      if (smokeOk) {
        console.log(`   ✅ A11y → LLM round-trip passed (window: "${windowTitle}")`);
        results.push({ name: 'Smoke test (a11y→LLM)', ok: true, detail: `Window "${windowTitle}" — model confirmed` });
      } else {
        console.log(`   ⚠️  LLM responded but didn't confirm (got: "${smokeText.substring(0, 40)}")`);
        results.push({ name: 'Smoke test (a11y→LLM)', ok: false, detail: `Model didn't follow instruction: "${smokeText.substring(0, 40)}"` });
      }
    } catch (err) {
      console.log(`   ⚠️  Smoke test skipped: ${err}`);
      results.push({ name: 'Smoke test (a11y→LLM)', ok: false, detail: `Error: ${err}` });
    }
  }

  // ─── 6. Interactive provider/model selection ───────────────────
  const recommendedPipeline = buildMixedPipeline(scanResults, modelTests);
  const gpuInfo = await detectGpuInfo();
  if (gpuInfo) {
    console.log(`\n🎮 GPU detected: ${gpuInfo}`);
  }

  const selected = await promptPipelineSelection(
    workingText,
    workingVision,
    recommendedPipeline,
  );
  const pipeline = buildPipelineFromSelection(scanResults, selected);

  console.log(`\n🧠 Selected pipeline:`);
  console.log(`   Layer 1: Action Router (offline) ✅`);
  console.log(`   Layer 2: ${pipeline.layer2.enabled ? `${pipeline.layer2.model} via ${providerNameForUrl(pipeline.layer2.baseUrl)}` : 'DISABLED'} ${pipeline.layer2.enabled ? '✅' : '❌'}`);
  console.log(`   Layer 3: ${pipeline.layer3.enabled ? `${pipeline.layer3.model} via ${providerNameForUrl(pipeline.layer3.baseUrl)}` : 'DISABLED'} ${pipeline.layer3.enabled ? '✅' : '❌'}`);
  if (pipeline.layer3.computerUse) {
    console.log(`   🖥️  Computer Use API: enabled (Anthropic native)`);
  }

  // ─── 7. Save Config ─────────────────────────────────────────────
  if (opts.save !== false) {
    savePipelineConfig(pipeline, scanResults);
  }

  // ─── 8. External Skill Registration (optional) ─────────────────
  await registerExternalSkills(results);

  // ─── Summary ────────────────────────────────────────────────────
  printSummary(results, pipeline);

  return pipeline;
}

/**
 * Legacy single-provider flow — used when both --provider and --api-key are explicitly given.
 * Preserves backward compatibility with CLI flags.
 */
async function runSingleProviderFlow(
  opts: { apiKey?: string; provider?: string; baseUrl?: string; textModel?: string; visionModel?: string; save?: boolean },
  results: DiagResult[],
): Promise<PipelineConfig | null> {
  const resolvedApi = resolveApiConfig(opts);
  const apiKey = resolvedApi.apiKey;
  const providerKey = detectProvider(apiKey, opts.provider);
  const baseProvider = PROVIDERS[providerKey];
  const provider: ProviderProfile = opts.baseUrl
    ? {
        ...baseProvider,
        name: `${baseProvider.name} (OpenAI-compatible endpoint)`,
        baseUrl: opts.baseUrl,
        openaiCompat: true,
        computerUse: false,
        textModel: opts.textModel || baseProvider.textModel,
        visionModel: opts.visionModel || baseProvider.visionModel,
      }
    : baseProvider;

  console.log(`\n🔑 AI Provider: ${provider.name} (explicit override)`);

  let textModelWorks = false;
  let visionModelWorks = false;
  let textModel = opts.textModel || provider.textModel;
  const visionModel = opts.visionModel || provider.visionModel;

  // Test text model (Layer 2)
  console.log(`   Testing ${textModel} (text)...`);
  const textResult = await testModel(provider, apiKey, textModel, false);
  if (textResult.ok) {
    textModelWorks = true;
    results.push({
      name: `Text model (${textModel})`,
      ok: true,
      detail: `${textResult.latencyMs}ms`,
      latencyMs: textResult.latencyMs,
    });
    console.log(`   ✅ ${textModel}: ${textResult.latencyMs}ms`);
  } else {
    results.push({ name: `Text model (${textModel})`, ok: false, detail: textResult.error || 'Failed' });
    console.log(`   ❌ ${textModel}: ${textResult.error}`);

    // Try fallback - if explicit provider fails, try Ollama with best available model
    if (providerKey !== 'ollama') {
      console.log(`   🔄 Trying Ollama fallback...`);
      try {
        const ollamaRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (ollamaRes.ok) {
          const ollamaData = await ollamaRes.json() as { models?: Array<{ name: string }> };
          const ollamaModels = (ollamaData.models || []).map((m: { name: string }) => m.name);
          const bestModel = pickOllamaTextModel(ollamaModels);
          if (bestModel) {
            const ollamaResult = await testModel(PROVIDERS['ollama'], '', bestModel, false);
            if (ollamaResult.ok) {
              textModelWorks = true;
              textModel = bestModel;
              console.log(`   ✅ Ollama ${bestModel}: ${ollamaResult.latencyMs}ms (fallback)`);
            } else {
              console.log(`   ❌ Ollama not available either`);
            }
          } else {
            console.log(`   ❌ Ollama running but no models pulled`);
          }
        } else {
          console.log(`   ❌ Ollama not available either`);
        }
      } catch {
        console.log(`   ❌ Ollama not available either`);
      }
    }
  }

  // Test vision model (Layer 3) — with actual image
  if (apiKey) {
    console.log(`   Testing ${visionModel} (vision)...`);
    const visionResult = await testModel(provider, apiKey, visionModel, true);
    if (visionResult.ok) {
      visionModelWorks = true;
      results.push({
        name: `Vision model (${visionModel})`,
        ok: true,
        detail: `${visionResult.latencyMs}ms`,
        latencyMs: visionResult.latencyMs,
      });
      console.log(`   ✅ ${visionModel}: ${visionResult.latencyMs}ms`);
    } else {
      results.push({ name: `Vision model (${visionModel})`, ok: false, detail: visionResult.error || 'Failed' });
      console.log(`   ❌ ${visionModel}: ${visionResult.error}`);
    }
  } else {
    console.log(`   ⚠️  No API key — vision model skipped`);
    results.push({ name: 'Vision model', ok: false, detail: 'No API key' });
  }

  // Build pipeline
  const pipeline = buildPipeline(
    providerKey, apiKey,
    textModelWorks, visionModelWorks,
    textModel !== provider.textModel ? textModel : undefined,
  );

  // Handle mixed providers (e.g., Ollama for text, cloud for vision)
  // If the text model was resolved from Ollama but the main provider is cloud, set Layer 2 to Ollama baseUrl
  if (providerKey !== 'ollama' && pipeline.layer2.model && !pipeline.layer2.baseUrl) {
    // Check if the text model is an Ollama model by testing the Ollama endpoint
    try {
      const testRes = await fetch(`http://localhost:11434/api/show`, {
        method: 'POST',
        body: JSON.stringify({ name: pipeline.layer2.model }),
        signal: AbortSignal.timeout(2000),
      });
      if (testRes.ok) {
        pipeline.layer2.baseUrl = PROVIDERS['ollama'].baseUrl;
      }
    } catch { /* not Ollama model, leave baseUrl as-is */ }
  }

  console.log(`\n🧠 Recommended pipeline:`);
  console.log(`   Layer 1: Action Router (offline, instant) ✅`);
  console.log(`   Layer 2: Accessibility Reasoner → ${pipeline.layer2.enabled ? pipeline.layer2.model : 'DISABLED'} ${pipeline.layer2.enabled ? '✅' : '❌'}`);
  console.log(`   Layer 3: Screenshot → ${pipeline.layer3.enabled ? pipeline.layer3.model : 'DISABLED'} ${pipeline.layer3.enabled ? '✅' : '❌'}`);
  if (pipeline.layer3.computerUse) {
    console.log(`   🖥️  Computer Use API: enabled (Anthropic native)`);
  }

  // Save Config
  if (opts.save !== false) {
    const configPath = path.join(path.resolve(__dirname, '..'), CONFIG_FILE);
    const configData = {
      provider: providerKey,
      pipeline: {
        layer2: {
          enabled: pipeline.layer2.enabled,
          model: pipeline.layer2.model,
          baseUrl: pipeline.layer2.baseUrl,
        },
        layer3: {
          enabled: pipeline.layer3.enabled,
          model: pipeline.layer3.model,
          computerUse: pipeline.layer3.computerUse,
        },
      },
      diagnosedAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    console.log(`\n💾 Config saved to ${CONFIG_FILE}`);
  }

  // External Skill Registration (optional)
  await registerExternalSkills(results);

  // Summary
  printSummary(results, pipeline);

  return pipeline;
}

/**
 * Test all available providers in parallel. Returns model test results.
 */
async function testAllProviders(scanResults: ProviderScanResult[]): Promise<ModelTestResult[]> {
  const promises: Promise<ModelTestResult>[] = [];

  for (const scan of scanResults) {
    if (!scan.available) continue;

    const provider = PROVIDERS[scan.key];
    if (!provider) continue;

    // ── Text model test ──────────────────────────────────────────
    if (scan.key === 'ollama') {
      // For Ollama, pick the best available text model
      const ollamaTextModel = pickOllamaTextModel(scan.ollamaModels || []);
      if (ollamaTextModel) {
        promises.push(
          testModelAsync(provider, scan.apiKey, ollamaTextModel, 'text', scan.key),
        );
      }
    } else {
      promises.push(
        testModelAsync(provider, scan.apiKey, provider.textModel, 'text', scan.key),
      );
    }

    // ── Vision model test ────────────────────────────────────────
    if (scan.key === 'ollama') {
      // For Ollama, only test vision if a vision-capable model exists
      const ollamaVisionModels = scan.ollamaVisionModels || [];
      if (ollamaVisionModels.length > 0) {
        promises.push(
          testModelAsync(provider, scan.apiKey, ollamaVisionModels[0], 'vision', scan.key),
        );
      }
    } else {
      // Cloud providers: test vision model
      promises.push(
        testModelAsync(provider, scan.apiKey, provider.visionModel, 'vision', scan.key),
      );
    }
  }

  const settled = await Promise.allSettled(promises);
  const testResults: ModelTestResult[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      testResults.push(result.value);
    }
    // rejected promises are silently dropped — the provider just doesn't work
  }

  return testResults;
}

interface ModelChoice {
  providerKey: string;
  model: string;
}

interface PipelineSelection {
  layer2: ModelChoice | null;
  layer3: ModelChoice | null;
}

function buildPipelineFromSelection(
  scanResults: ProviderScanResult[],
  selected: PipelineSelection,
): PipelineConfig {
  const primaryProviderKey = selected.layer3?.providerKey || selected.layer2?.providerKey || 'ollama';
  const primaryProvider = PROVIDERS[primaryProviderKey] || PROVIDERS['ollama'];
  const primaryScan = scanResults.find(s => s.key === primaryProviderKey);
  const primaryApiKey = primaryScan?.apiKey || '';

  const layer2Provider = selected.layer2 ? (PROVIDERS[selected.layer2.providerKey] || PROVIDERS['ollama']) : primaryProvider;
  const layer3Provider = selected.layer3 ? (PROVIDERS[selected.layer3.providerKey] || PROVIDERS['ollama']) : primaryProvider;

  return {
    provider: primaryProvider,
    providerKey: primaryProviderKey,
    apiKey: primaryApiKey,
    layer1: true,
    layer2: {
      enabled: !!selected.layer2,
      model: selected.layer2?.model || layer2Provider.textModel,
      baseUrl: layer2Provider.baseUrl,
    },
    layer3: {
      enabled: !!selected.layer3,
      model: selected.layer3?.model || layer3Provider.visionModel,
      baseUrl: layer3Provider.baseUrl,
      computerUse: !!selected.layer3 && layer3Provider.computerUse,
    },
  };
}

async function detectGpuInfo(): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=name,memory.total',
        '--format=csv,noheader,nounits',
      ]);
      const lines = stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

      if (lines.length === 0) return null;

      return lines
        .map(line => {
          const parts = line.split(',').map(p => p.trim());
          return parts.length >= 2 ? `${parts[0]} (${parts[1]} MB VRAM)` : line;
        })
        .join(' | ');
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      // system_profiler -json is the canonical Mac GPU query.
      const { stdout } = await execFileAsync('system_profiler', [
        'SPDisplaysDataType',
        '-json',
      ]);
      const data = JSON.parse(stdout) as { SPDisplaysDataType?: Record<string, unknown>[] };
      const entries = data?.SPDisplaysDataType ?? [];

      const gpus = await Promise.all(
        entries.map(async (d: Record<string, unknown>) => {
          const name = (d['sppci_model'] as string | undefined) || (d['_name'] as string | undefined) || 'Unknown GPU';
          // Discrete GPUs (Intel/AMD/NVIDIA on older Macs) expose VRAM directly.
          const vram = (d['spdisplays_vram'] as string | undefined) || (d['spdisplays_vram_shared'] as string | undefined);
          if (vram) return `${name} (${vram} VRAM)`;

          // Apple Silicon uses unified memory — show GPU cores + total RAM instead.
          const gpuCores = d['sppci_cores'] as string | number | undefined;
          if (gpuCores) {
            let unifiedMem = '';
            try {
              const { stdout: memOut } = await execFileAsync('sysctl', ['-n', 'hw.memsize']);
              const bytes = parseInt(memOut.trim(), 10);
              if (!Number.isNaN(bytes)) {
                unifiedMem = ` / ${Math.round(bytes / 1073741824)} GB unified`;
              }
            } catch { /* ignore */ }
            return `${name} (${gpuCores} GPU cores${unifiedMem})`;
          }

          return name;
        }),
      );

      const filtered = gpus.filter(Boolean) as string[];
      return filtered.length > 0 ? filtered.join(' | ') : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function promptPipelineSelection(
  workingText: ModelTestResult[],
  workingVision: ModelTestResult[],
  recommended: PipelineConfig,
): Promise<PipelineSelection> {
  const recommendedText = recommended.layer2.enabled
    ? { providerKey: providerKeyForUrl(recommended.layer2.baseUrl) || recommended.providerKey, model: recommended.layer2.model }
    : null;
  const recommendedVision = recommended.layer3.enabled
    ? { providerKey: providerKeyForUrl(recommended.layer3.baseUrl) || recommended.providerKey, model: recommended.layer3.model }
    : null;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      layer2: recommendedText,
      layer3: recommendedVision,
    };
  }

  console.log('\n🧩 Choose your pipeline models (press Enter for recommended).');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const layer2 = await promptCategoryChoice(
      rl,
      'TEXT LLM (Layer 2)',
      workingText,
      recommendedText,
    );
    const layer3 = await promptCategoryChoice(
      rl,
      'VISION LLM (Layer 3)',
      workingVision,
      recommendedVision,
    );
    return { layer2, layer3 };
  } finally {
    rl.close();
  }
}

async function promptCategoryChoice(
  rl: readline.Interface,
  title: string,
  options: ModelTestResult[],
  recommendedChoice: ModelChoice | null,
): Promise<ModelChoice | null> {
  console.log(`\n${title}:`);

  if (options.length === 0) {
    console.log('   No working models found. This layer will be disabled.');
    return null;
  }

  options.forEach((opt, idx) => {
    const providerName = PROVIDERS[opt.providerKey]?.name || opt.providerKey;
    const recommendedMark = (recommendedChoice && opt.providerKey === recommendedChoice.providerKey && opt.model === recommendedChoice.model) ? ' ★ recommended' : '';
    const latency = opt.latencyMs ? `, ${opt.latencyMs}ms` : '';
    console.log(`   ${idx + 1}. ${opt.model} (${providerName}${latency})${recommendedMark}`);
  });

  const recommendedIndex = recommendedChoice
    ? options.findIndex(opt => opt.providerKey === recommendedChoice.providerKey && opt.model === recommendedChoice.model)
    : -1;
  const defaultIndex = recommendedIndex >= 0 ? recommendedIndex : 0;

  const input = await askQuestion(
    rl,
    `   Pick 1-${options.length} (Enter=${defaultIndex + 1}): `,
  );
  const trimmed = input.trim();

  if (!trimmed) {
    const selected = options[defaultIndex];
    return { providerKey: selected.providerKey, model: selected.model };
  }

  const selectedIdx = Number(trimmed);
  if (!Number.isInteger(selectedIdx) || selectedIdx < 1 || selectedIdx > options.length) {
    console.log(`   Invalid choice "${trimmed}". Using default ${defaultIndex + 1}.`);
    const selected = options[defaultIndex];
    return { providerKey: selected.providerKey, model: selected.model };
  }

  const selected = options[selectedIdx - 1];
  return { providerKey: selected.providerKey, model: selected.model };
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

/**
 * Pick the best Ollama text model from available models.
 * Prefers: qwen2.5 variants, then llama variants, then first available.
 */
function pickOllamaTextModel(models: string[]): string | null {
  if (models.length === 0) return null;

  // Prefer qwen2.5 models (good for tool calling)
  const qwen = models.find(m => m.toLowerCase().startsWith('qwen2.5'));
  if (qwen) return qwen;

  // Then llama models
  const llama = models.find(m => m.toLowerCase().startsWith('llama'));
  if (llama) return llama;

  // Then qwen3 models
  const qwen3 = models.find(m => m.toLowerCase().startsWith('qwen3'));
  if (qwen3) return qwen3;

  // Then deepseek models
  const deepseek = models.find(m => m.toLowerCase().startsWith('deepseek'));
  if (deepseek) return deepseek;

  // Skip vision-only models
  const nonVision = models.find(m => !isLikelyVisionOnly(m));
  if (nonVision) return nonVision;

  // Last resort: first model
  return models[0];
}

function isLikelyVisionOnly(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('llava') || lower.startsWith('bakllava') || lower.startsWith('moondream');
}

/**
 * Test a model asynchronously, returning a ModelTestResult.
 */
async function testModelAsync(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
  role: 'text' | 'vision',
  providerKey: string,
): Promise<ModelTestResult> {
  const result = await testModel(provider, apiKey, model, role === 'vision');
  return {
    providerKey,
    model,
    role,
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

/**
 * Save pipeline config to disk, including multi-provider info.
 */
function savePipelineConfig(pipeline: PipelineConfig, scanResults: ProviderScanResult[]): void {
  // Always save to the package directory so loadPipelineConfig finds it reliably
  const configPath = path.join(path.resolve(__dirname, '..'), CONFIG_FILE);

  // Determine which providers are actually used
  const layer2ProviderKey = providerKeyForUrl(pipeline.layer2.baseUrl) || pipeline.providerKey;
  const layer3ProviderKey = providerKeyForUrl(pipeline.layer3.baseUrl) || pipeline.providerKey;
  const layer2Scan = scanResults.find(s => s.key === layer2ProviderKey);
  const layer3Scan = scanResults.find(s => s.key === layer3ProviderKey);

  const configData = {
    provider: pipeline.providerKey,
    pipeline: {
      layer2: {
        enabled: pipeline.layer2.enabled,
        model: pipeline.layer2.model,
        baseUrl: pipeline.layer2.baseUrl,
        provider: layer2ProviderKey,
      },
      layer3: {
        enabled: pipeline.layer3.enabled,
        model: pipeline.layer3.model,
        baseUrl: pipeline.layer3.baseUrl,
        computerUse: pipeline.layer3.computerUse,
        provider: layer3ProviderKey,
      },
    },
    // Store API keys by provider so we can reconstruct later
    providerKeys: Object.fromEntries(
      scanResults
        .filter(s => s.available && s.apiKey)
        .map(s => [s.key, '(set via env)'])
    ),
    diagnosedAt: new Date().toISOString(),
  };

  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
  console.log(`\n💾 Config saved to ${CONFIG_FILE}`);
}

/**
 * Look up provider key from a base URL.
 */
function providerKeyForUrl(baseUrl: string): string | null {
  for (const [key, profile] of Object.entries(PROVIDERS)) {
    if (profile.baseUrl === baseUrl) return key;
  }
  return null;
}

/**
 * Get a human-friendly provider name from a base URL.
 */
function providerNameForUrl(baseUrl: string): string {
  for (const profile of Object.values(PROVIDERS)) {
    if (profile.baseUrl === baseUrl) return profile.name;
  }
  return baseUrl;
}

/**
 * Print "no providers found" help message.
 */
function printNoProvidersHelp(results: DiagResult[]): void {
  console.log(`\n   ❌ No AI providers found!\n`);
  console.log(`   Option 1 (Free, local):`);
  console.log(`      Install Ollama: https://ollama.ai`);
  console.log(`      Then: ollama pull <model>  (e.g. qwen2.5:7b, llama3.2, gemma2)\n`);
  console.log(`   Option 2 (Cloud):`);
  console.log(`      Get an API key from any OpenAI-compatible provider:`);
  console.log(`      - Anthropic: https://console.anthropic.com (has Computer Use)`);
  console.log(`      - OpenAI: https://platform.openai.com`);
  console.log(`      - Groq: https://console.groq.com`);
  console.log(`      - Together: https://api.together.xyz`);
  console.log(`      - DeepSeek: https://platform.deepseek.com`);
  console.log(`      - Any OpenAI-compatible endpoint`);
  console.log(`      Then: clawdcursor install --api-key YOUR_KEY\n`);

  results.push({ name: 'AI Providers', ok: false, detail: 'No providers available' });
  results.push({ name: 'Text model', ok: false, detail: 'No providers available' });
  results.push({ name: 'Vision model', ok: false, detail: 'No providers available' });
}

/**
 * Print the final summary.
 */
function printSummary(results: DiagResult[], pipeline: PipelineConfig): void {
  const allOk = results.every(r => r.ok);
  console.log(`\n${'═'.repeat(50)}`);
  if (allOk) {
    console.log(`✅ All systems go! Run 'clawdcursor start' to begin.`);
  } else {
    const failures = results.filter(r => !r.ok);
    console.log(`⚠️  ${failures.length} issue(s) detected:`);
    for (const f of failures) {
      console.log(`   ❌ ${f.name}: ${f.detail}`);
    }

    const textFailed = !pipeline.layer2.enabled;
    const visionFailed = !pipeline.layer3.enabled;

    if (textFailed || visionFailed) {
      console.log(`\n💡 Quick fixes:\n`);
    }
    if (textFailed) {
      console.log(`   Text LLM missing — needed for accessibility reasoning (Layer 2)`);
      console.log(`   Free (local):  ollama pull <model> && ollama serve  (e.g. qwen2.5:7b, llama3.2)`);
      console.log(`   Cloud:         clawdcursor install --provider <provider> --api-key YOUR_KEY`);
      console.log('');
    }
    if (visionFailed) {
      console.log(`   Vision LLM missing — needed for screenshot analysis (Layer 3)`);
      console.log(`   Run:           clawdcursor install --provider <provider> --api-key YOUR_KEY`);
      console.log(`   Supported:     Any provider with vision models (Anthropic, OpenAI, Groq, etc.)`);
      console.log('');
    }
    if (visionFailed && !textFailed) {
      console.log(`   ℹ️  Running without vision — action router + accessibility reasoner handle most tasks.`);
    }
  }
  console.log('');
}

/**
 * Register Clawd Cursor as a skill in detected external platforms (OpenClaw, Codex, etc.).
 * Purely optional — skips silently if no platforms are installed.
 */
async function registerExternalSkills(results: DiagResult[]): Promise<void> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (!homeDir) return;

  const clawdCursorRoot = path.resolve(__dirname, '..');

  // Each entry: [platform name, skills directory path, target folder name]
  const platforms: [string, string, string][] = [
    ['OpenClaw', path.join(homeDir, '.openclaw', 'workspace', 'skills'), 'clawdcursor'],
    ['OpenClaw (dev)', path.join(homeDir, '.openclaw-dev', 'workspace', 'skills'), 'clawdcursor'],
    ['OpenClaw (flat)', path.join(homeDir, '.openclaw', 'skills'), 'clawdcursor'],
    ['Codex', path.join(homeDir, '.codex', 'skills'), 'clawdcursor'],
  ];

  let registered = 0;
  for (const [name, skillsDir, folderName] of platforms) {
    if (!fs.existsSync(skillsDir)) continue;

    const skillTarget = path.join(skillsDir, folderName);

    if (fs.existsSync(skillTarget)) {
      registered++;
      continue; // Already registered
    }

    try {
      fs.symlinkSync(clawdCursorRoot, skillTarget, process.platform === 'win32' ? 'junction' : 'dir');
      // Silent in v0.7.0 — standalone, external skill link is optional
      results.push({ name: `${name} skill`, ok: true, detail: 'Registered' });
      registered++;
    } catch {
      try {
        fs.mkdirSync(skillTarget, { recursive: true });
        fs.copyFileSync(
          path.join(clawdCursorRoot, 'SKILL.md'),
          path.join(skillTarget, 'SKILL.md')
        );
        results.push({ name: `${name} skill`, ok: true, detail: 'Registered (SKILL.md copied)' });
        registered++;
      } catch { /* non-critical */ }
    }
  }

  if (registered === 0) {
    // No external platforms found — that's fine, clawdcursor works standalone
  }
}

/**
 * Check for newer versions on GitHub releases.
 */
async function checkForUpdates(results: DiagResult[]): Promise<void> {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const currentVersion = pkg.version || '0.0.0';
    console.log(`   Current: v${currentVersion}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      'https://api.github.com/repos/AmrDab/clawdcursor/releases/latest',
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawdcursor-doctor' },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as any;
      const latestTag = (data.tag_name || '').replace(/^v/, '');

      if (latestTag && latestTag !== currentVersion && compareVersions(latestTag, currentVersion) > 0) {
        console.log(`   ⬆️  Update available: v${latestTag} (you have v${currentVersion})`);
        const updateCmd = process.platform === 'win32'
          ? 'git pull origin main; npm install; npm run build'
          : 'git pull origin main && npm install && npm run build';
        console.log(`   Run: ${updateCmd}`);
        results.push({
          name: 'Version',
          ok: false,
          detail: `Update available: v${latestTag} (current: v${currentVersion})`,
        });
      } else {
        console.log(`   ✅ Up to date (v${currentVersion})`);
        results.push({ name: 'Version', ok: true, detail: `v${currentVersion} (latest)` });
      }
    } else {
      // GitHub API rate limit or error — skip gracefully
      console.log(`   ✅ v${currentVersion} (update check skipped — GitHub API returned ${res.status})`);
      results.push({ name: 'Version', ok: true, detail: `v${currentVersion} (update check skipped)` });
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log(`   ⚠️  Update check timed out (5s) — skipping`);
    } else {
      console.log(`   ⚠️  Update check failed — skipping`);
    }
    // Don't fail the doctor for a version check issue
    const pkgPath = path.join(__dirname, '..', 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      results.push({ name: 'Version', ok: true, detail: `v${pkg.version} (update check unavailable)` });
    } catch {
      results.push({ name: 'Version', ok: true, detail: 'unknown (update check unavailable)' });
    }
  }
}

/**
 * Simple semver comparison. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Test if a model is responding AND can follow instructions.
 * Text models: "Reply with exactly: CLAWD_OK" → verify response contains CLAWD_OK.
 * Vision models: send a 1x1 green pixel → verify non-empty meaningful response.
 */
async function testModel(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
  isVision: boolean,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (isVision) {
    return testVisionModel(provider, apiKey, model);
  }
  return testTextModel(provider, apiKey, model);
}

/** Text model: verify instruction-following, not just connectivity */
async function testTextModel(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = performance.now();
  const TIMEOUT = 8000;
  const INSTRUCTION = 'Reply with exactly one word: CLAWD_OK — nothing else.';

  try {
    let text = '';

    if (provider.openaiCompat) {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.authHeader(apiKey),
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          temperature: 0,
          messages: [{ role: 'user', content: INSTRUCTION }],
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const data = await response.json() as any;
      if (data.error) {
        return { ok: false, error: extractErrorMessage(data.error) };
      }
      text = data.choices?.[0]?.message?.content || '';
    } else {
      // Anthropic API
      const response = await fetch(`${provider.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.authHeader(apiKey),
          ...provider.extraHeaders,
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: 'user', content: INSTRUCTION }],
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const data = await response.json() as any;
      if (data.type === 'error' && data.error) {
        const hint = (data.error.type === 'not_found_error' || data.error.type === 'invalid_request_error')
          ? ' — check model id matches your provider'
          : '';
        return { ok: false, error: extractErrorMessage(data.error) + hint };
      }
      if (data.error) {
        return { ok: false, error: extractErrorMessage(data.error) };
      }
      text = data.content?.[0]?.text || '';
    }

    if (!text) return { ok: false, error: 'Empty response' };

    // Verify instruction-following
    if (!text.includes('CLAWD_OK')) {
      return { ok: false, error: `Model responded but didn't follow instructions (got: "${text.substring(0, 50)}")` };
    }

    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, error: `Timeout (${TIMEOUT / 1000}s)` };
    }
    return { ok: false, error: err.message || String(err) };
  }
}

/** Vision model: send a real image and verify the model can process it */
async function testVisionModel(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = performance.now();
  const TIMEOUT = 10000; // vision needs slightly more time

  // 8x8 solid green PNG (89 bytes) — smallest valid PNG that's unambiguously green
  const GREEN_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12Ng+M9AEwYAGJgBgV6GPOYAAAAASUVORK5CYII=';

  try {
    const text = await callVisionLLMDirect({
      baseUrl: provider.baseUrl,
      model,
      apiKey,
      isAnthropic: !provider.openaiCompat,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: GREEN_PIXEL_PNG } },
          { type: 'text', text: 'What color is this image? Reply with one word.' },
        ],
      }],
      maxTokens: 20,
      timeoutMs: TIMEOUT,
      retries: 0,
    });

    if (!text) return { ok: false, error: 'Empty response — model may not support vision' };

    // Any non-empty response proves the model accepted the image
    // Bonus: check if it said "green" (but don't require it — some models describe differently)
    const lower = text.toLowerCase();
    const recognizedColor = lower.includes('green') || lower.includes('color');
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - start),
      ...(recognizedColor ? {} : {}), // response is valid either way
    };
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, error: `Timeout (${TIMEOUT / 1000}s)` };
    }
    // Common error: model doesn't support multimodal input
    const msg = err.message || String(err);
    if (msg.includes('image') || msg.includes('multimodal') || msg.includes('vision')) {
      return { ok: false, error: `Model does not support vision input: ${msg}` };
    }
    return { ok: false, error: msg };
  }
}

/** Extract a human-readable error message from an API error response */
function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    return (error as any).message || JSON.stringify(error);
  }
  return String(error);
}

/**
 * Load saved pipeline config from disk.
 */
function resolveProviderApiKey(providerKey: string, fallbackApiKey?: string): string {
  const normalizedProvider = (providerKey || '').toLowerCase();
  if (!normalizedProvider) return fallbackApiKey || '';

  const resolved = resolveApiConfig({ provider: normalizedProvider });
  if (resolved.apiKey) return resolved.apiKey;

  return fallbackApiKey || '';
}

export function loadPipelineConfig(): PipelineConfig | null {
  const pkgDir = path.resolve(__dirname, '..');
  let configPath = path.join(pkgDir, CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    configPath = path.join(process.cwd(), CONFIG_FILE);
  }

  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const providerKey = raw.provider || 'ollama';
    const provider = PROVIDERS[providerKey] || PROVIDERS['ollama'];
    // Resolve API key: check provider-scoped env vars FIRST, then fall back to
    // generic resolution. This prevents OpenClaw auth-profiles (e.g. a stale
    // Anthropic key) from overriding the correct provider-specific key.
    const scopedEnvKey = (PROVIDER_ENV_VARS[providerKey] || [])
      .map(k => process.env[k])
      .find(v => v && v.length > 0) || '';
    const resolvedDefault = resolveApiConfig();
    const defaultApiKey = scopedEnvKey || resolvedDefault.apiKey;

    // Support mixed-provider configs saved by the new doctor
    const layer2BaseUrl = raw.pipeline?.layer2?.baseUrl ?? provider.baseUrl;
    const layer3BaseUrl = raw.pipeline?.layer3?.baseUrl ?? provider.baseUrl;
    const layer3ProviderKey = raw.pipeline?.layer3?.provider || providerKey;
    const layer3ComputerUse = raw.pipeline?.layer3?.computerUse ?? false;
    const explicitLayer3ApiKey = raw.pipeline?.layer3?.apiKey;

    return {
      provider,
      providerKey,
      apiKey: defaultApiKey,
      layer1: true,
      layer2: {
        enabled: raw.pipeline?.layer2?.enabled ?? false,
        model: raw.pipeline?.layer2?.model ?? provider.textModel,
        baseUrl: layer2BaseUrl,
      },
      layer3: {
        enabled: raw.pipeline?.layer3?.enabled ?? false,
        model: raw.pipeline?.layer3?.model ?? provider.visionModel,
        baseUrl: layer3BaseUrl,
        computerUse: layer3ComputerUse,
        apiKey: layer3ComputerUse
          ? (explicitLayer3ApiKey || resolveProviderApiKey(layer3ProviderKey, defaultApiKey))
          : undefined,
      },
    };
  } catch {
    return null;
  }
}
