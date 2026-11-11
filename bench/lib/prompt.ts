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

export function buildPrompt(task: TaskSpec, window: string): string {
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
    `When you have finished, end your reply with exactly one line: "${DONE_MARK}" if the task is done, or "${FAILED_MARK}" if it is not.`,
  ].join('\n');
}
