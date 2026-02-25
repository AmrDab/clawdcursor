/**
 * 🩺 Clawd Cursor Doctor - diagnoses setup and auto-configures the pipeline.
 *
 * Tests:
 * 1. Screen capture (nut-js)
 * 2. Accessibility bridge (PowerShell / osascript)
 * 3. Input control (keyboard/mouse)
 * 4. AI provider connectivity + model availability
 * 5. Builds optimal 3-layer pipeline config
 */

import * as fs from 'fs';
import * as path from 'path';
import { NativeDesktop } from './native-desktop';
import { AccessibilityBridge } from './accessibility';
import { PROVIDERS, detectProvider, buildPipeline } from './providers';
import type { PipelineConfig, ProviderProfile } from './providers';
import { DEFAULT_CONFIG } from './types';

const CONFIG_FILE = '.clawd-config.json';

interface DiagResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export async function runDoctor(opts: {
  apiKey?: string;
  provider?: string;
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

  // ─── 3. AI Provider ─────────────────────────────────────────────
  const apiKey = opts.apiKey || process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
  const providerKey = detectProvider(apiKey, opts.provider);
  const provider = PROVIDERS[providerKey];

  console.log(`\n🔑 AI Provider: ${provider.name}`);

  let textModelWorks = false;
  let visionModelWorks = false;
  let textModel = provider.textModel;
  let visionModel = provider.visionModel;

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

    // Try fallback - if Anthropic fails, try Ollama
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
    const visionResult = await testModel(provider, apiKey, visionModel, false); // text-only test is enough to verify API access
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
    console.log(`   ⚠️  No API key - vision model skipped`);
    results.push({ name: 'Vision model', ok: false, detail: 'No API key' });
  }

  // ─── 4. Build Pipeline ──────────────────────────────────────────
  const pipeline = buildPipeline(
    providerKey, apiKey,
    textModelWorks, visionModelWorks,
    textModel !== provider.textModel ? textModel : undefined,
    visionModel !== provider.visionModel ? visionModel : undefined,
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

  // ─── 5. Save Config ─────────────────────────────────────────────
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

  // ─── Summary ────────────────────────────────────────────────────
  const allOk = results.every(r => r.ok);
  console.log(`\n${'═'.repeat(50)}`);
  if (allOk) {
    console.log(`✅ All systems go! Run 'clawd-cursor start' to begin.`);
  } else {
    const failures = results.filter(r => !r.ok);
    console.log(`⚠️  ${failures.length} issue(s) detected:`);
    for (const f of failures) {
      console.log(`   ❌ ${f.name}: ${f.detail}`);
    }
    if (!visionModelWorks && textModelWorks) {
      console.log(`\n💡 Running without vision - accessibility reasoner + action router will handle most tasks.`);
    }
  }
  console.log('');

  return pipeline;
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
    const apiKey = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';

    return {
      provider,
      providerKey,
      apiKey,
      layer1: true,
      layer2: {
        enabled: raw.pipeline?.layer2?.enabled ?? false,
        model: raw.pipeline?.layer2?.model ?? provider.textModel,
        baseUrl: raw.pipeline?.layer2?.baseUrl ?? provider.baseUrl,
      },
      layer3: {
        enabled: raw.pipeline?.layer3?.enabled ?? false,
        model: raw.pipeline?.layer3?.model ?? provider.visionModel,
        baseUrl: provider.baseUrl,
        computerUse: raw.pipeline?.layer3?.computerUse ?? false,
      },
    };
  } catch {
    return null;
  }
}
