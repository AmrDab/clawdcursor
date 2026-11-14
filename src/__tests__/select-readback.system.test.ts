/**
 * #396: `select` on a WinForms list box answered ok while the app never heard of it. ps-bridge's select reads the
 * item's IsSelected back after Select(), and tells a WinForms list box's parent (LBN_SELCHANGE) as a user pick does -
 * only that: a child list box that notifies, its real parent (GA_PARENT, never a popup's owner), in its own process.
 * Run for real with fake elements and the harness's recording Win32UIA: no message reaches a real window.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { INVOKE_FUNCTIONS, INVOKE_SETUP, runPsCases } from './helpers/ps-bridge-harness';

const WINFORMS = 'WindowsForms10.LISTBOX.app.0.34f5582_r6_ad1';
const CHILD_NOTIFY = '0x40000001';   // WS_CHILD | LBS_NOTIFY

describe.runIf(process.platform === 'win32')('ps-bridge select (run for real, fake list boxes)', () => {
  // A list box (hwnd 300, parent 200) holding the item "High"; -> the reply, then the messages sent.
  const select = (opts: { cls?: string; style?: string; listPid?: number; dadPid?: number; pattern?: string } = {}) => `
$list = New-FakeEl -Name 'Priority' -Type List -Hwnd 300 -ClassName '${opts.cls ?? WINFORMS}'
$item = New-FakeEl -Name 'High' -Type ListItem -Parent $list -Patterns @{ SelectionItem = (${opts.pattern ?? 'New-SelectionItemPattern'}) }
[Win32UIA]::Parents[300] = 200; [Win32UIA]::Styles[300] = ${opts.style ?? CHILD_NOTIFY}
[Win32UIA]::Pids[300] = ${opts.listPid ?? 7}; [Win32UIA]::Pids[200] = ${opts.dadPid ?? 7}
Invoke-Fake @($item) @{ name = 'High'; action = 'select' }
"sent: $(@([Win32UIA]::Calls | Where-Object { $_ -like 'SendMessage*' }) -join ';')"`;
  const CASES = {
    winforms: select(),
    plainListBox: select({ cls: 'ListBox' }),
    winformsCombo: select({ cls: 'WindowsForms10.COMBOBOX.app.0.34f5582_r6_ad1' }),
    noNotify: select({ style: '0x40000000' }),
    notChild: select({ style: '0x00000001' }),
    otherProcess: select({ dadPid: 8 }),
    alreadySelected: select({ pattern: 'New-SelectionItemPattern -Selected' }),
    didNotTake: select({ pattern: 'New-SelectionItemPattern -Ignores' }),
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, { reply: { success: boolean; data?: { selected?: boolean } }; sent: string }>;
  beforeAll(() => {
    const out = runPsCases(INVOKE_FUNCTIONS, INVOKE_SETUP, keys.map(k => CASES[k]));
    r = Object.fromEntries(keys.map((k, i) => [k, { reply: JSON.parse(out[i][0]), sent: out[i][1] }])) as typeof r;
  }, 120_000);

  it('the item is read back after Select(): data.selected', () => {
    expect(r.winforms.reply).toMatchObject({ success: true, data: { selected: true } });
    expect(r.alreadySelected.reply).toMatchObject({ success: true, data: { selected: true } });
    expect(r.didNotTake.reply).toMatchObject({ success: true, data: { selected: false } });
  });

  it('a WinForms child list box that notifies gets WM_COMMAND (LBN_SELCHANGE << 16 | its id) at its real parent', () => {
    expect(r.winforms.sent).toBe(`sent: SendMessageTimeout 200 273 ${(1 << 16) | 5} 300`);
  });

  it('anything else is sent nothing: a Win32 list box or a combo box (their proxies notify), no LBS_NOTIFY, not a child, another process, no change', () => {
    for (const k of ['plainListBox', 'winformsCombo', 'noNotify', 'notChild', 'otherProcess', 'alreadySelected', 'didNotTake'] as const) {
      expect(r[k].sent.trim(), k).toBe('sent:');
    }
  });
});
