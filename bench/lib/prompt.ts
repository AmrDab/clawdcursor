/** The prompt every agent gets: the privacy rules first, then the task, then how to end. */
import { DONE_MARK, FAILED_MARK } from './scorer';
import type { TaskSpec } from './types';

export const PRIVACY_RULES = [
  'Work ONLY in the fixture window named below. It is already open.',
  'Never list windows, tabs, displays or processes.',
  'Never read, focus, open, move or close any other window or app, and never open another page or file.',
  'Use only the clawdcursor tools. Do not change a page with scripts (no browser evaluate).',
  'If the task cannot be done inside these rules, stop and say so.',
];

/** --save-routines: the line that asks the agent to use routines (measures replay, not whether an agent saves unasked). */
export const ROUTINES_LINE = 'This task may be asked again. If a saved routine fits it, replay it first (the batch tool, replay). When the task is done, save it (the batch tool, save_as and description) before you end.';

export function buildPrompt(task: TaskSpec, window: string, routines = false): string {
  return [
    'You are driving a desktop through the clawdcursor tools. This is an automated benchmark on a person\'s own computer.',
    '',
    'Rules. They come before the task:',
    ...PRIVACY_RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    `Fixture window: ${window}`,
    '',
    `Task: ${task.prompt}`,
    '',
    ...(routines ? [ROUTINES_LINE, ''] : []),
    `When you have finished, end your reply with exactly one line: "${DONE_MARK}" if the task is done, or "${FAILED_MARK}" if it is not.`,
  ].join('\n');
}
