/**
 * 🩺 Clawd Cursor Doctor - diagnoses setup and auto-configures the pipeline.
 *
 * Tests:
 * 1. Screen capture (nut-js)
 * 2. Accessibility bridge (PowerShell / osascript)
 * 3. Input control (keyboard/mouse)
 * 4. AI provider connectivity + model availability (ALL providers in parallel)
 * 5. Builds optimal mixed 3-layer pipeline config
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
import { resolveApiConfig } from './openclaw-credentials';

const CONFIG_FILE = '.clawd-config.json';
const execFileAsync = promisify(execFile);

interface DiagResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export async function runDoctor(opts: {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  textModel?: string;
  visionModel?: string;
  save?: boolean;
}): Promise<PipelineConfig | null> {
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
      anthropic: 'ANTHROPIC_API_KEY — https://console.anthropic.com (best vision + computer use)',
      openai: 'OPENAI_API_KEY — https://platform.openai.com (GPT-4o vision)',
      kimi: 'MOONSHOT_API_KEY — https://platform.moonshot.cn (256k context, affordable)',
    };
    for (const scan of unavailableCloud) {
      if (keyInfo[scan.key]) {
        console.log(`      ${scan.name}: set ${keyInfo[scan.key]}`);
      }
    }
    console.log(`      Set in .env file or as environment variable, then re-run: clawdcursor doctor`);

    // Offer to input key right now if interactive
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rlSetup = readline.createInterface({ input: process.stdin, output: process.stdout });
      const keyInput = await new Promise<string>(resolve =>
        rlSetup.question('\n   🔑 Paste an API key now to add a provider (or Enter to skip): ', resolve)
      );
      rlSetup.close();

      const trimmedKey = keyInput.trim();
      if (trimmedKey) {
        const detectedKey = detectProvider(trimmedKey);
        if (detectedKey && PROVIDERS[detectedKey]) {
          const matchingScan = scanResults.find(s => s.key === detectedKey);
          if (matchingScan) {
            matchingScan.available = true;
            matchingScan.apiKey = trimmedKey;
            matchingScan.detail = `key added (${trimmedKey.substring(0, 8)}...)`;
            console.log(`   ✅ Detected ${PROVIDERS[detectedKey].name} key! Testing...`);

            // Save to .env for persistence
            const envPath = path.join(process.cwd(), '.env');
            const envVarName = detectedKey === 'anthropic' ? 'ANTHROPIC_API_KEY' :
                               detectedKey === 'openai' ? 'OPENAI_API_KEY' :
                               detectedKey === 'kimi' ? 'MOONSHOT_API_KEY' : 'AI_API_KEY';
            const envLine = `${envVarName}=${trimmedKey}\n`;
            try {
              fs.appendFileSync(envPath, envLine);
              console.log(`   💾 Saved to .env as ${envVarName}`);
            } catch {
              console.log(`   ⚠️ Could not save to .env — set ${envVarName} manually`);
            }
          }
        } else {
          console.log(`   ⚠️ Could not detect provider for this key. Set it manually in .env`);
        }
      }
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

  // ─── 5. Interactive provider/model selection ───────────────────
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

  // ─── 6. Save Config ─────────────────────────────────────────────
  if (opts.save !== false) {
    savePipelineConfig(pipeline, scanResults);
  }

  // ─── 7. OpenClaw Skill Registration ──────────────────────────────
  await registerOpenClawSkill(results);

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

    // Try fallback - if explicit provider fails, try Ollama
    if (providerKey !== 'ollama') {
      console.log(`   🔄 Trying Ollama fallback...`);
      const ollamaResult = await testModel(PROVIDERS['ollama'], '', 'qwen2.5:7b', false);
      if (ollamaResult.ok) {
        textModelWorks = true;
        textModel = 'qwen2.5:7b';
        console.log(`   ✅ Ollama qwen2.5:7b: ${ollamaResult.latencyMs}ms (fallback)`);
      } else {
        console.log(`   ❌ Ollama not available either`);
      }
    }
  }

  // Test vision model (Layer 3)
  if (apiKey) {
    console.log(`   Testing ${visionModel} (vision)...`);
    const visionResult = await testModel(provider, apiKey, visionModel, false);
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

  // Handle mixed providers (e.g., Ollama for text, Anthropic for vision)
  if (textModel === 'qwen2.5:7b' && providerKey !== 'ollama') {
    pipeline.layer2.baseUrl = PROVIDERS['ollama'].baseUrl;
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
    const configPath = path.join(process.cwd(), CONFIG_FILE);
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

  // OpenClaw Skill Registration
  await registerOpenClawSkill(results);

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
  const configPath = path.join(process.cwd(), CONFIG_FILE);

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
  console.log(`      Then: ollama pull qwen2.5:7b\n`);
  console.log(`   Option 2 (Cloud):`);
  console.log(`      Get an API key from one of:`);
  console.log(`      - Anthropic: https://console.anthropic.com (recommended, has Computer Use)`);
  console.log(`      - OpenAI: https://platform.openai.com`);
  console.log(`      - Kimi: https://platform.moonshot.cn`);
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
      console.log(`   Free (local):  ollama pull qwen2.5:7b && ollama serve`);
      console.log(`   Cloud:         clawdcursor install --provider anthropic --api-key YOUR_API_KEY_HERE`);
      console.log('');
    }
    if (visionFailed) {
      console.log(`   Vision LLM missing — needed for screenshot analysis (Layer 3)`);
      console.log(`   Run:           clawdcursor install --provider anthropic --api-key YOUR_API_KEY_HERE`);
      console.log(`   Supported:     Anthropic, OpenAI, or Kimi (requires API key)`);
      console.log('');
    }
    if (visionFailed && !textFailed) {
      console.log(`   ℹ️  Running without vision — action router + accessibility reasoner handle most tasks.`);
    }
  }
  console.log('');
}

/**
 * Register Clawd Cursor as an OpenClaw skill by symlinking into the workspace skills folder.
 */
async function registerOpenClawSkill(results: DiagResult[]): Promise<void> {
  console.log('🔗 OpenClaw skill registration...');

  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (!homeDir) {
      console.log('   ⚠️  Could not determine home directory — skipping');
      return;
    }

    // Check common OpenClaw workspace locations
    const candidates = [
      path.join(homeDir, '.openclaw', 'workspace', 'skills'),
      path.join(homeDir, '.openclaw-dev', 'workspace', 'skills'),
    ];

    let skillsDir: string | null = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        skillsDir = candidate;
        break;
      }
    }

    if (!skillsDir) {
      console.log('   ℹ️  OpenClaw not detected — skipping skill registration');
      console.log('   💡 Install OpenClaw (https://openclaw.ai) to use Clawd Cursor as an AI skill');
      return;
    }

    const skillTarget = path.join(skillsDir, 'clawdcursor');
    const clawdCursorRoot = path.resolve(__dirname, '..');

    // Check if already registered
    if (fs.existsSync(skillTarget)) {
      // Verify it points to the right place
      try {
        const stat = fs.lstatSync(skillTarget);
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(skillTarget);
          if (path.resolve(linkTarget) === clawdCursorRoot) {
            console.log('   ✅ Already registered as OpenClaw skill');
            results.push({ name: 'OpenClaw skill', ok: true, detail: 'Registered (symlink)' });
            return;
          }
          // Wrong symlink — remove and recreate
          fs.unlinkSync(skillTarget);
        } else {
          // It's a real directory — check if SKILL.md exists and is current
          const existingSkill = path.join(skillTarget, 'SKILL.md');
          if (fs.existsSync(existingSkill)) {
            console.log('   ✅ Already registered as OpenClaw skill');
            results.push({ name: 'OpenClaw skill', ok: true, detail: 'Registered (directory)' });
            return;
          }
        }
      } catch {
        // Can't read — try to recreate
      }
    }

    // Create symlink (or copy on Windows if symlink fails)
    try {
      fs.symlinkSync(clawdCursorRoot, skillTarget, process.platform === 'win32' ? 'junction' : 'dir');
      console.log('   ✅ Registered as OpenClaw skill');
      console.log(`   📂 ${skillTarget} → ${clawdCursorRoot}`);
      results.push({ name: 'OpenClaw skill', ok: true, detail: 'Registered (symlink created)' });
    } catch (symlinkErr) {
      // Symlink failed (permissions) — copy SKILL.md instead
      try {
        fs.mkdirSync(skillTarget, { recursive: true });
        fs.copyFileSync(
          path.join(clawdCursorRoot, 'SKILL.md'),
          path.join(skillTarget, 'SKILL.md')
        );
        console.log('   ✅ Registered as OpenClaw skill (copied SKILL.md)');
        results.push({ name: 'OpenClaw skill', ok: true, detail: 'Registered (SKILL.md copied)' });
      } catch (copyErr) {
        console.log(`   ❌ Failed to register: ${copyErr}`);
        results.push({ name: 'OpenClaw skill', ok: false, detail: String(copyErr) });
      }
    }
  } catch (err) {
    console.log(`   ⚠️  ${err}`);
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
      'https://api.github.com/repos/AmrDab/clawd-cursor/releases/latest',
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'clawd-cursor-doctor' },
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
 * Test if a model is responding.
 */
async function testModel(
  provider: ProviderProfile,
  apiKey: string,
  model: string,
  _isVision: boolean,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = performance.now();

  try {
    if (provider.openaiCompat) {
      // OpenAI-compatible API (OpenAI, Ollama, Kimi)
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...provider.authHeader(apiKey),
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply OK' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (data.error) {
        const msg = typeof data.error === 'object' && data.error !== null
          ? (data.error.message || JSON.stringify(data.error))
          : String(data.error);
        return { ok: false, error: msg };
      }
      const text = data.choices?.[0]?.message?.content || '';
      if (!text) return { ok: false, error: 'Empty response' };

      return { ok: true, latencyMs: Math.round(performance.now() - start) };
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
          messages: [{ role: 'user', content: 'Reply OK' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (data.type === 'error' && data.error) {
        const err = data.error;
        const msg = typeof err === 'object' && err !== null
          ? (err.message || JSON.stringify(err))
          : String(err);
        const hint = (err.type === 'not_found_error' || err.type === 'invalid_request_error')
          ? ' — check model id (e.g. claude-3-5-haiku-20241022 or claude-haiku-4-5)'
          : '';
        return { ok: false, error: msg + hint };
      }
      if (data.error) {
        const msg = typeof data.error === 'object' && data.error !== null
          ? (data.error.message || JSON.stringify(data.error))
          : String(data.error);
        return { ok: false, error: msg };
      }

      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    }
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { ok: false, error: 'Timeout (15s)' };
    }
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Load saved pipeline config from disk.
 */
export function loadPipelineConfig(): PipelineConfig | null {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const providerKey = raw.provider || 'ollama';
    const provider = PROVIDERS[providerKey] || PROVIDERS['ollama'];
    const apiKey = resolveApiConfig().apiKey;

    // Support mixed-provider configs saved by the new doctor
    const layer2BaseUrl = raw.pipeline?.layer2?.baseUrl ?? provider.baseUrl;
    const layer3BaseUrl = raw.pipeline?.layer3?.baseUrl ?? provider.baseUrl;

    return {
      provider,
      providerKey,
      apiKey,
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
        computerUse: raw.pipeline?.layer3?.computerUse ?? false,
      },
    };
  } catch {
    return null;
  }
}
