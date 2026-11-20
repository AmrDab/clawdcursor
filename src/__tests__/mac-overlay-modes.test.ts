import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const swift = fs.readFileSync(path.join(ROOT, 'scripts', 'mac', 'overlay.swift'), 'utf8');
const banner = fs.readFileSync(path.join(ROOT, 'src', 'core', 'banner.ts'), 'utf8');

describe('macOS overlay: pill, outline, glow', () => {
  it('is one binary with three modes', () => {
    expect(swift).toContain('mode == "pill" || mode == "outline" || mode == "glow"');
    expect(swift).toContain('else if mode == "glow" { glow() }');
  });

  it('the glow starts hidden and takes ON / OFF / HIDE on stdin; it is click-through and out of captures', () => {
    const glow = swift.slice(swift.indexOf('func glow()'), swift.indexOf('let mode = CommandLine'));
    expect(glow).toContain('ignoresMouseEvents = true');
    expect(glow).toContain('sharingType = .none');
    expect(glow).toContain('level = .statusBar');
    expect(glow).not.toContain('orderFrontRegardless');   // hidden until ON
    expect(swift).toContain('line == "ON" || line == "OFF"');
    expect(swift).toContain('if mode == "glow" { glowHideUntil');
    expect(swift).toContain('NSApp.terminate(nil)');       // stdin EOF
  });

  it('the outline sits just above the agent window, takes several TARGET pairs, and draws the ghost cursor', () => {
    expect(swift).toContain('win.order(.above, relativeTo:');
    expect(swift).toContain('win.level = .normal');
    expect(swift).toContain('while i + 1 < parts.count');
    expect(swift).toContain('line == "GHOST" || line.hasPrefix("GHOST ")');
    const ghost = swift.slice(swift.indexOf('func showGhost'), swift.indexOf('func updateGhost'));
    expect(ghost).toContain('ignoresMouseEvents = true');
    expect(ghost).toContain('sharingType = .none');
    expect(ghost).toContain('addingTimeInterval(1.5)');
  });

  it('the pill drags by its body, stays .screenSaver, and keeps the orb', () => {
    expect(swift).toContain('override func mouseDragged');
    expect(swift).toContain('panel.level = .screenSaver');
    expect(swift).toContain('let orb = makeOrb()');
    expect(swift).toContain('final class OrbView: NSView');
  });

  it('the ghost draws the agent cursor (no eyes), the grid between markers matching scripts/agent-cursor.json', () => {
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'agent-cursor.json'), 'utf8'));
    const m = swift.match(/\/\/ AGENT-CURSOR-BEGIN\n([\s\S]*?)\/\/ AGENT-CURSOR-END/);
    expect(m).not.toBeNull();
    expect([...m![1].matchAll(/"([^"]+)"/g)].map(x => x[1])).toEqual(art.rows);
    expect(swift.slice(swift.indexOf('func showGhost'), swift.indexOf('func updateGhost'))).toContain('CursorView(cell: 2)');
  });

  it('banner.ts spawns the glow, and sends the ghost and the one-window line, on darwin too', () => {
    expect(banner).toMatch(/platform === 'darwin'\) return spawn\(macOverlayBinary\.cached\(macScript\(\)\)!, \['glow', \.\.\.color\]/);   // blue at a pause
    expect(banner).toContain("const line = w ? `TARGET ${outlineWindowNumber(w.handle, w.processId)} ${w.processId}` : 'TARGET';");   // one window, every OS
    expect(banner).toContain("if (process.platform === 'win32' || process.platform === 'darwin') send(this.outlineChild, `GHOST");
  });
});
