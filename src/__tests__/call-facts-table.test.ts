/**
 * The per-call facts the guards read — allowed while a pause waits / while stopped, an image-space pointer call, a full
 * screenshot — for every granular tool and every compound action. Written once in compact names; a granular tool has the
 * facts of its route (compact-routes.ts COMPOUND_ROUTE_INDEX), so the two surfaces can not disagree about the same handler.
 */
import { describe, it, expect } from 'vitest';
import { getAllTools } from '../tools/registry';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact-routes';
import { isImagePointerCall, isFullScreenshotCall } from '../tools/screen-guard';
import { guardedCall } from '../tools/call-guards';

function facts(tool: string, action?: string): string {
  const c = guardedCall(tool, action, {});
  return [
    c.pauseSafe && 'pause-safe',
    c.stopSafe && 'stop-safe',
    isImagePointerCall(tool, action, { x: 1, y: 1 }) && 'image-pointer',
    isFullScreenshotCall(tool, action) && 'screenshot',
  ].filter(Boolean).join(' ');
}

describe('per-call facts', () => {
  it('every granular tool and compound action that has one', () => {
    const calls: Array<[string, string | undefined]> = [
      ...getAllTools().map(t => [t.name, undefined] as [string, undefined]),
      ...Object.entries(COMPOUND_ROUTE_INDEX).flatMap(([c, routes]) => routes.map(r => [c, r.action] as [string, string])),
    ];
    const rows = calls.map(([t, a]) => [a ? `${t}:${a}` : t, facts(t, a)]).filter(([, f]) => f).map(([k, f]) => `${k.padEnd(28)}${f}`);
    expect(`\n${rows.join('\n')}\n`).toMatchInlineSnapshot(`
      "
      desktop_screenshot          screenshot
      mouse_double_click          image-pointer
      mouse_right_click           image-pointer
      mouse_hover                 image-pointer
      wait                        pause-safe
      session_report              pause-safe stop-safe
      telemetry_optout            pause-safe stop-safe
      mouse_middle_click          image-pointer
      mouse_triple_click          image-pointer
      mouse_scroll_horizontal     image-pointer
      mouse_drag_stepped          image-pointer
      pause_for_user              pause-safe stop-safe
      resume_task                 pause-safe
      screenshot_full             screenshot
      mouse_click                 image-pointer
      mouse_drag                  image-pointer
      mouse_scroll                image-pointer
      computer:click              image-pointer
      computer:double_click       image-pointer
      computer:right_click        image-pointer
      computer:middle_click       image-pointer
      computer:triple_click       image-pointer
      computer:hover              image-pointer
      computer:move               image-pointer
      computer:mouse_move         image-pointer
      computer:scroll             image-pointer
      computer:scroll_horizontal  image-pointer
      computer:drag               image-pointer
      computer:drag_path          image-pointer
      computer:wait               pause-safe
      computer:screenshot         screenshot
      system:report               pause-safe stop-safe
      system:telemetry_optout     pause-safe stop-safe
      system:pause_for_user       pause-safe stop-safe
      "
    `);
  });
});
