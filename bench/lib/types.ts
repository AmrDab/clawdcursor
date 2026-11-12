/**
 * Shared types of the benchmark (issue #384).
 *
 * A TASK names an app archetype, a prompt, a predicate on the fixture's own state, an oracle (the cost of a scripted
 * trajectory) and the mechanisms (M1-M5, issues #385-#389) it guards. Success is never judged by a model.
 */

export const ARCHETYPES = ['web-form', 'web-target-resolution', 'web-timing', 'web-canvas', 'web-reading', 'native-dialog',
  'store-uwp', 'document-editor', 'cad-viewport'] as const;
export type Archetype = typeof ARCHETYPES[number];

export const MECHANISMS = ['M1', 'M2', 'M3', 'M4', 'M5'] as const;
export type Mechanism = typeof MECHANISMS[number];

export const OSES = ['windows', 'macos', 'linux'] as const;
export type BenchOs = typeof OSES[number];

/** What the runner opens for a task, and where its state is read from. */
export type FixtureSpec =
  /** A page of the fixture HTTP server, opened in a private browser window. State: what the page POSTs. */
  | { kind: 'web'; page: string; query?: Record<string, string> }
  /** The native fixture app (WinForms / AppKit / GTK). State: the JSON file it writes. */
  | { kind: 'native'; mode: 'dialog' | 'editor' }
  /** A real app, skipped when it is not installed. State: a read-only probe of the app, or none (manual verify). */
  | { kind: 'app'; app: 'calculator' | 'textedit' | 'designcenter' };

/** A predicate on fixture state. `path` is dotted ("submitted.name"); `count` counts matching events. */
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | ({ path: string } & Comparison)
  | ({ count: { type?: string; target?: string } } & Comparison);

export interface Comparison {
  equals?: unknown;
  notEquals?: unknown;
  /** A regular expression the value (as a string) must match. */
  matches?: string;
  gte?: number;
  lte?: number;
  /** Arrays: the same members in any order. */
  sameMembers?: unknown[];
  exists?: boolean;
}

export interface TaskSpec {
  id: string;
  archetype: Archetype;
  os: BenchOs[];
  /** M1-M5: the mechanisms this task guards. */
  mechanisms: Mechanism[];
  /** One line for the README table: the bug class this task catches. */
  guards: string;
  fixture: FixtureSpec;
  /** What the agent is asked to do. The privacy rules and the fixture window's name are added by the runner. */
  prompt: string;
  /** Success, read from the fixture state. Absent only on a manual-verify task. */
  success?: Predicate;
  /** A task whose result cannot be read from state: metrics only, never in the gate. */
  manualVerify?: boolean;
  /** A scripted trajectory: one read, then one call per action, no batch. */
  oracle: { screenshots: number; calls: number };
  /** The watchdog stops the agent past these. */
  caps: { calls: number; seconds: number };
}

/** One recorded interaction with a fixture. `t` is epoch ms on the recorder's clock (the fixture server, or the native app). */
export interface FixtureEvent { t: number; type: string; target?: string; value?: unknown; trusted?: boolean }

export interface FixtureState { state: Record<string, unknown>; events: FixtureEvent[];
  /** Web fixtures: how many times the page was loaded. More than one fails the run (a reload resets the page's counters). */
  loads?: number }

/** One line of the isolated server's session log (src/surface/session-log.ts). It never carries arguments or text. */
export interface LogCall {
  t: string; tool: string; action?: string;
  cls: 'blind' | 'vision' | 'act-name' | 'act-coords' | 'act-other';
  ok: boolean; ms: number; outcome?: string; app?: string; code?: string;
  /** Who the act went to, read by clawdcursor when it sent it: the app's process (for a Store app, the app its frame hosts) and the window handle. */
  appPid?: number; appHandle?: number;
  steps?: Array<{ tool: string; action?: string; cls: LogCall['cls']; ok: boolean; outcome: string; app?: string }>;
}

/** A call as the adapter saw the model make it: `sig` is a hash of tool + arguments (the session log has no arguments). */
export interface CallSig { tool: string; sig: string }

export interface AgentRun {
  /** The agent's last message. */
  finalText: string;
  exitCode: number | null;
  /** Set when the watchdog stopped the agent. */
  killed?: { rule: string; detail: string };
  /**
   * The agent could not reach clawdcursor: the MCP connection, its initialize or its tools/list failed. That is a
   * failure of the server under test, never an "agent error", whatever the agent then did or said.
   */
  serverUnreachable?: string;
  sigs: CallSig[];
  seconds: number;
}
