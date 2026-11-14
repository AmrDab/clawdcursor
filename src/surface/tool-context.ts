/**
 * The ToolContext every MCP handler receives, built the same way for `clawdcursor mcp` (stdio) and the daemon (HTTP).
 */
import type { ToolContext } from '../tools/types';
import { getLogBuffer } from './log-buffer';

/**
 * Image-space → mouse-driver factor for the image the model was last sent.
 * Physical px on Windows/Linux (= screenshot scale); logical points on macOS
 * (logical width / image width — may be < 1, e.g. a 2560-px panel shown at
 * 1024 points). Read live, never cached.
 */
function mouseScaleFor(
  desktop: { getScaleFactor(): number; getLlmWidth(): number },
  macLogicalWidth: number,
): number {
  const llmW = desktop.getLlmWidth();
  if (process.platform === 'darwin' && macLogicalWidth > 0 && llmW > 0) return macLogicalWidth / llmW;
  return desktop.getScaleFactor();
}

export async function createToolContext(opts: { disableVision: boolean }): Promise<ToolContext> {
  const { NativeDesktop } = await import('../platform/native-desktop');
  const { AccessibilityBridge } = await import('../platform/accessibility');
  const { CDPDriver } = await import('../platform/cdp-driver');
  const { DEFAULT_CONFIG } = await import('../types');
  const { DEFAULT_CDP_PORT } = await import('../platform/browser-config');
  const { getPlatform } = await import('../platform');

  const desktop = new NativeDesktop({ ...DEFAULT_CONFIG });
  const a11y = new AccessibilityBridge();
  const cdp = new CDPDriver(DEFAULT_CDP_PORT);
  // Session-scoped el_NN UIMap cache. Without this, compile_ui / find_* and
  // the {element_id, snapshot_id} ref path fail with "no UIMap holder on this
  // context" over stdio MCP — the v1.5.0 substrate was unreachable for editor-
  // hosted agents (only the `agent` daemon constructed one). Gauntlet F1.
  const { UIMapHolder } = await import('../core/sense/ui-map-holder');
  const uiMaps = new UIMapHolder();
  // Lazy adapter handle — Tranche 1A primitives run through this. Populated
  // in ensureInitialized so we share the same adapter the unified pipeline uses.
  let platform: import('../platform/types').PlatformAdapter | undefined;

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  // macOS logical (point) width; 0 elsewhere. Scale factors are read LIVE from
  // the desktop's last capture (mouseScaleFor) — freezing them at startup broke
  // clicks after a rotation / resolution change.
  let macLogicalWidth = 0;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await desktop.connect();
      platform = await getPlatform();
      // mouse factor: image-space → mouse-driver coords (see mouseScaleFor).
      //  • Windows / Linux: nut-js drives PHYSICAL px → the screenshot scale.
      //  • macOS: nut-js drives LOGICAL points; on Retina physical≠logical and
      //    the physical scale double-counts the backing scale (#154).
      if (process.platform === 'darwin') {
        try {
          const lsize = await platform.getScreenSize(); // NSScreen logical + physical dims
          macLogicalWidth = lsize?.logicalWidth ?? 0;
        } catch { /* best-effort fallback: physical scale */ }
      }
      await a11y.warmup();
      initialized = true;
      console.log(`Subsystems initialized (mouseScale=${mouseScaleFor(desktop, macLogicalWidth)}, screenshotScale=${desktop.getScaleFactor()})`);
    })();
    return initPromise;
  };

  return {
    desktop, a11y, cdp, uiMaps,
    get platform() { return platform; },
    getLogBuffer,
    disableVision: opts.disableVision,
    getMouseScaleFactor: () => mouseScaleFor(desktop, macLogicalWidth),
    getScreenshotScaleFactor: () => desktop.getScaleFactor(),
    ensureInitialized,
  };
}
