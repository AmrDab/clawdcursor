/**
 * The oracle of every task: a SCRIPTED trajectory, minimal but realistic. Its length is the task's oracle.
 *
 * Realistic means what a careful agent that already knows the app would still do:
 *   focus    confirm (or bring up) the fixture window
 *   read     one look before acting: the accessibility tree or the page text. On a canvas: a screenshot
 *   wait     a bounded wait for something the task says comes later
 *   act      one call per action, no batch
 *   verify   one look after the last action, to see that it worked
 * The first version of the oracles left out the focus and the verifying read, and a model that solved a trap task in
 * four clean calls (focus, read, press, verify) failed a gate built on two.
 *
 * The counts are MEASURED, not typed in: `--selfcheck` runs each script (web: in a headless browser; native: through
 * the fixture's own self-test) and checks that the task's predicate holds afterwards, and a unit test checks that
 * every task spec carries exactly the counts of its script. `--selfcheck --write-oracles` writes them into the specs.
 */
import type { Page } from 'playwright';

export type StepKind = 'focus' | 'read' | 'wait' | 'act' | 'verify';

export interface OracleStep {
  kind: StepKind;
  /** The tool call this stands for. */
  call: string;
  /** This step takes a screenshot (a look at a surface with no accessibility tree). */
  shot?: boolean;
  /** Web: what the step does to the page. */
  web?: (p: Page) => Promise<unknown>;
  /** Native: the fixture's `--do` token for this step (acts only). */
  native?: string;
}

const focus: OracleStep = { kind: 'focus', call: 'window focus', web: p => p.bringToFront() };
const read: OracleStep = { kind: 'read', call: 'accessibility read_tree', web: p => p.locator('body').ariaSnapshot() };
const verify: OracleStep = { kind: 'verify', call: 'accessibility read_tree', web: p => p.locator('body').ariaSnapshot() };
const look: OracleStep = { kind: 'read', call: 'computer screenshot', shot: true, web: p => p.screenshot() };
const lookAgain: OracleStep = { kind: 'verify', call: 'computer screenshot', shot: true, web: p => p.screenshot() };
const act = (call: string, web: (p: Page) => Promise<unknown>): OracleStep => ({ kind: 'act', call, web });
const nativeAct = (call: string, native: string): OracleStep => ({ kind: 'act', call, native });
const click = (name: string, selector: string) => act(`accessibility invoke "${name}"`, p => p.click(selector));
/** One accessibility action per trap: focus, read, press the right element, verify. */
const trap = (name: string, selector: string): OracleStep[] => [focus, read, click(name, selector), verify];

/** The canvas sits 20 px into the page: page coordinates. */
async function drag(p: Page, from: [number, number], to: [number, number]): Promise<void> {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move(to[0], to[1], { steps: 3 });
  await p.mouse.up();
}

export const ORACLES: Record<string, OracleStep[]> = {
  'web-form-fill': [
    focus, read,
    act('accessibility set_value "Full name"', p => p.fill('#name', 'Ada Lovelace')),
    act('accessibility set_value "Quantity"', p => p.fill('#qty', '7')),
    act('accessibility select "Shipping"', p => p.selectOption('#shipping', 'Express')),
    act('accessibility toggle "Gift wrap"', p => p.check('#gift')),
    act('accessibility toggle "Newsletter"', p => p.uncheck('#newsletter')),
    act('accessibility expand "Advanced options"', p => p.click('summary')),
    act('accessibility toggle "Fragile"', p => p.check('#fragile')),
    act('accessibility set_value "Delivery note"', async p => { await p.click('#note'); await p.keyboard.type('Leave at the side door'); }),
    click('Confirm', '#confirm'),
    verify,
  ],
  'web-trap-new': trap('New', '[data-bench="new"]'),
  'web-trap-dialog-close': trap('Close', '[data-bench="dialogClose"]'),
  'web-trap-hidden-link': trap('Download report', '[data-bench="visibleLink"]'),
  'web-trap-label-button': trap('Export', '[data-bench="exportButton"]'),
  'web-timing-late-dialog': [
    focus, read,
    click('Start export', '#start'),
    { kind: 'wait', call: 'accessibility wait_for "Export ready"', web: p => p.waitForSelector('#download', { state: 'visible', timeout: 8000 }) },
    click('Download', '#download'),
    verify,
  ],
  'web-timing-gated-field': [
    focus, read,
    click('Open editor', '#open'),
    { kind: 'wait', call: 'accessibility wait_for "Ready"', web: p => p.waitForFunction(() => document.getElementById('editorStatus')!.textContent === 'Ready', undefined, { timeout: 8000 }) },
    act('accessibility set_value "Project code"', p => p.fill('#code', 'ORBIT-42')),
    click('Save', '#save'),
    verify,
  ],
  'web-canvas-draw': [focus, look, act('computer drag', p => drag(p, [120, 120], [520, 520])), lookAgain],
  'web-canvas-targets': [
    focus, look,
    ...([[110, 100], [520, 130], [320, 320], [130, 530], [540, 500]] as Array<[number, number]>).map(([x, y]) => act('computer click', p => p.mouse.click(x, y))),
    lookAgain,
  ],
  'web-long-read': [
    focus,
    { kind: 'read', call: 'system copy_all_text', web: p => p.locator('body').innerText() },
    act('accessibility set_value "Answer"', async p => {
      // What the read is for: the code in the row of station Delta-17.
      const code = await p.locator('tr', { has: p.locator('td', { hasText: /^Delta-17$/ }) }).locator('td').nth(1).innerText();
      await p.fill('#answer', code);
    }),
    click('Submit', '#submit'),
    verify,
  ],

  'native-dialog-fill': [
    focus, read,
    nativeAct('accessibility set_value "Name"', 'name=Grace Hopper'),
    nativeAct('accessibility set_value "Email"', 'email=grace@example.com'),
    nativeAct('accessibility select "High"', 'priority=High'),
    nativeAct('accessibility toggle "Subscribe"', 'subscribe=on'),
    nativeAct('accessibility invoke "Apply"', 'click=apply'),
    verify,
  ],
  'native-dialog-modal': [
    focus, read,
    nativeAct('accessibility invoke "Delete..."', 'click=delete'),
    nativeAct('accessibility invoke "OK" (the dialog)', 'click=modalOk'),
    verify,
  ],
  'native-dialog-duplicate': [focus, read, nativeAct('accessibility invoke "Edit" (Shipping)', 'click=shippingEdit'), verify],
  'editor-type-lines': [focus, read, nativeAct('accessibility set_value "Document"', 'text=Benchmark line one\\nBenchmark line two'), verify],

  // Real apps: the script is the same shape, but nothing here can run it without the app on screen. Its counts stand;
  // the live run is its execution.
  'calc-multiply': [focus, read, { kind: 'act', call: 'computer type "47*89="' }, verify],
  'textedit-type-lines': [focus, read, { kind: 'act', call: 'accessibility set_value (the document)' }, verify],
  'cad-designcenter-orbit': [focus, look, { kind: 'act', call: 'computer drag (middle button)' }, { kind: 'act', call: 'computer key (fit)' }, lookAgain],
};

/** The oracle a script amounts to: one call per step, one screenshot per step that looks at pixels. */
export function oracleCounts(steps: OracleStep[]): { calls: number; screenshots: number } {
  return { calls: steps.length, screenshots: steps.filter(s => s.shot).length };
}

/** What makes a script "minimal but realistic". Empty when it is. */
export function scriptProblems(steps: OracleStep[]): string[] {
  const problems: string[] = [];
  const firstAct = steps.findIndex(s => s.kind === 'act');
  if (steps[0]?.kind !== 'focus') problems.push('it must start by focusing (or confirming) the fixture window');
  if (firstAct < 0) problems.push('it has no action');
  else if (!steps.slice(0, firstAct).some(s => s.kind === 'read')) problems.push('it must look (a read or a screenshot) before its first action');
  if (steps[steps.length - 1]?.kind !== 'verify') problems.push('it must end with one verifying look');
  if (steps.filter(s => s.kind === 'focus').length > 1 || steps.filter(s => s.kind === 'verify').length > 1) problems.push('one focus and one verifying look: more is not minimal');
  if (steps.filter(s => s.kind === 'read').length > 1) problems.push('one read before acting: more is not minimal');
  return problems;
}

/** The `--do` argument of the native fixture for a script: its actions, in order. */
export function nativeDo(steps: OracleStep[]): string {
  return steps.filter(s => s.native).map(s => s.native).join(';');
}

/** Can this script be run here without the app on screen? Web: every step has a page action. Native: every act has a token. */
export function runnable(steps: OracleStep[]): 'web' | 'native' | null {
  if (steps.every(s => s.web)) return 'web';
  if (steps.every(s => s.kind !== 'act' || s.native)) return 'native';
  return null;
}
