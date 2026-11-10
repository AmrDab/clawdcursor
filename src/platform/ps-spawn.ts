/**
 * Options for every powershell.exe clawdcursor starts. Windows PowerShell writes Microsoft/Windows/PowerShell/ModuleAnalysisCache
 * under LOCALAPPDATA, and under the WORKING DIRECTORY when its environment has none (a harness that strips it), where
 * `git add -A` then commits it. So a PowerShell child runs from the temp dir unless the caller says otherwise. Paths a script
 * resolves are absolute and do not depend on it.
 */
import * as os from 'os';

export function psOpts<const T extends object>(options?: T): T & { cwd: string } {
  return { ...(options as T), cwd: (options as { cwd?: string } | undefined)?.cwd ?? os.tmpdir() };
}
