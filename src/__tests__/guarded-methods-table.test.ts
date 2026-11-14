/**
 * Which methods of an input layer are guarded and how (window-checked input, or stop-only), and what the pill says for
 * each: one table (pointer-guard.ts GUARDED_METHODS) feeds both, so a method can not be guarded without words on the
 * pill, or named on the pill without being guarded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { guardInputMethods, setInputGuard } from '../platform/pointer-guard';
import { activityLabel } from '../core/banner';

const METHODS = [
  'mouseClick', 'mouseDoubleClick', 'mouseRightClick', 'mouseDown', 'mouseUp', 'mouseDrag', 'mouseScroll', 'mouseMove',
  'mouseMoveRelative', 'typeText', 'keyPress', 'keyDown', 'keyUp',
  'invokeElement', 'scrollIntoView', 'setWindowState', 'setWindowBounds', 'navigate', 'click', 'clickByText', 'typeInField',
  'typeByLabel', 'focus', 'selectOption', 'pressKey', 'writeClipboard', 'evaluate', 'switchTab', 'launchApp', 'focusWindow',
  'readClipboard', 'getUiTree',
];

afterEach(() => setInputGuard(null));

describe('guarded methods', () => {
  it('how each method is guarded, and what the pill says for it', async () => {
    const calls: string[] = [];
    setInputGuard({
      stopCheck: () => { calls.push('stop'); }, before: async () => { calls.push('window'); }, done: () => {},
      focused: async () => {}, launched: async () => {}, byName: async () => { calls.push('byName'); },
    });
    const layer = guardInputMethods(Object.fromEntries(METHODS.map(m => [m, vi.fn(async () => true)])));
    const rows: string[] = [];
    for (const m of METHODS) {
      calls.length = 0;
      await (layer as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]('x', 1);
      rows.push(`${m.padEnd(18)}${[...new Set(calls)].join('+') || '-'} | ${activityLabel(m, 'msedge') ?? '-'}`);
    }
    expect(`\n${rows.join('\n')}\n`).toMatchInlineSnapshot(`
      "
      mouseClick        stop+window | Clicking in Edge
      mouseDoubleClick  stop+window | Clicking in Edge
      mouseRightClick   stop+window | Clicking in Edge
      mouseDown         stop+window | Clicking in Edge
      mouseUp           - | -
      mouseDrag         stop+window | Dragging in Edge
      mouseScroll       stop+window | Scrolling in Edge
      mouseMove         stop | -
      mouseMoveRelative stop | -
      typeText          stop+window | Typing in Edge
      keyPress          stop+window | Pressing keys in Edge
      keyDown           stop+window | Pressing keys in Edge
      keyUp             - | -
      invokeElement     stop+byName | Clicking
      scrollIntoView    stop | Scrolling
      setWindowState    stop | Arranging windows
      setWindowBounds   stop | Arranging windows
      navigate          stop | Opening a page
      click             stop | Clicking
      clickByText       stop | Clicking
      typeInField       stop | Typing
      typeByLabel       stop | Typing
      focus             stop | Clicking
      selectOption      stop | Choosing an option
      pressKey          stop | Pressing keys
      writeClipboard    stop | -
      evaluate          stop | -
      switchTab         stop | -
      launchApp         stop | Opening an app
      focusWindow       stop | -
      readClipboard     - | -
      getUiTree         - | -
      "
    `);
  });
});
