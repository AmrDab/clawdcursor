/**
 * A Store (UWP) app's window belongs to ApplicationFrameHost, one process for every Store app. Get-HostedApp names the
 * app a frame hosts: the owner of the frame's Windows.UI.Core.CoreWindow child, its process name and display name.
 * Run for real with a fake LaunchWin (CoreOf) and the harness's Win32UIA (the CoreWindow's process); the hosted
 * process is this PowerShell itself, so its name and display name are real. The adapter side is in frame-host.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runPsJson } from './helpers/ps-bridge-harness';

describe.runIf(process.platform === 'win32')('ps-bridge Get-HostedApp (run for real, a fake frame)', () => {
  let r: unknown[];
  let self: number;
  beforeAll(() => {
    const setup = `Add-Type 'public static class LaunchWin { public static System.Collections.Generic.Dictionary<long, long> Cores = new System.Collections.Generic.Dictionary<long, long>();
  public static System.IntPtr CoreOf(System.IntPtr h) { long c; return Cores.TryGetValue(h.ToInt64(), out c) ? new System.IntPtr(c) : System.IntPtr.Zero; } }'
$script:AppNames = @{}
[LaunchWin]::Cores[7003] = 9001; [LaunchWin]::Cores[7005] = 9002
function Hosted($h, $cls, $wpid) { [Win32UIA]::Pids[9001] = $PID; [Win32UIA]::Pids[9002] = 38636; ConvertTo-Json -InputObject @{ hosted = (Get-HostedApp ([IntPtr]$h) $cls $wpid) } -Compress }`;
    const out = runPsJson(['Get-HostedApp', 'Use-LaunchWin', 'Get-AppName'], setup, [
      'Hosted 7003 ApplicationFrameWindow 38636',   // a frame whose CoreWindow belongs to another process: that app
      'Hosted 7003 Notepad 38636',                  // not a frame: none
      'Hosted 7004 ApplicationFrameWindow 38636',   // a frame whose app has not come up (no CoreWindow): none
      'Hosted 7005 ApplicationFrameWindow 38636',   // a CoreWindow of the frame's own process: none
      '$PID',
    ]);
    self = out[4] as number;
    r = out.slice(0, 4).map(o => (o as { hosted: unknown }).hosted);
  }, 120_000);

  it('a frame names the process of its CoreWindow, with its name and display name', () => {
    expect(r[0]).toEqual({ processId: self, processName: 'powershell', appName: expect.stringMatching(/^Windows PowerShell/) });
  });

  it('anything else is no hosted app: another class, no CoreWindow yet, a CoreWindow of the frame host itself', () => {
    expect(r.slice(1)).toEqual([null, null, null]);
  });
});
