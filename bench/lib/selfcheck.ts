/**
 * `npm run bench -- --selfcheck`: proves the fixtures and the task predicates without an agent and without a window.
 *
 * Web: each web task's page is driven by a scripted trajectory in a HEADLESS browser, once the right way (the predicate
 * must hold) and once into the trap (it must not). Native: the fixture's own --selftest (off screen, never activated).
 * It is not part of the unit tests: it needs an installed Chromium browser.
 */
import { chromium, type Page } from 'playwright';
import { startFixtureServer } from './fixture-server';
import { evaluate, loadTasks } from './tasks';
import type { TaskSpec } from './types';

type Script = (p: Page) => Promise<void>;

/** Per web task: [the right trajectory, a wrong one]. */
const SCRIPTS: Record<string, [Script, Script]> = {
  'web-form-fill': [
    async p => {
      await p.fill('#name', 'Ada Lovelace');
      await p.fill('#qty', '7');
      await p.selectOption('#shipping', 'Express');
      await p.check('#gift');
      await p.uncheck('#newsletter');
      await p.click('summary');
      await p.check('#fragile');
      await p.click('#note');
      await p.keyboard.type('Leave at the side door');
      await p.click('#confirm');
    },
    async p => { await p.fill('#name', 'Ada Lovelace'); await p.click('#confirm'); },
  ],
  'web-trap-new': [p => p.click('[data-bench="new"]'), p => p.click('[data-bench="whatsNew"]')],
  'web-trap-dialog-close': [p => p.click('[data-bench="dialogClose"]'), p => p.click('[data-bench="pageClose"]')],
  'web-trap-hidden-link': [
    p => p.click('[data-bench="visibleLink"]'),
    p => p.evaluate(() => (document.querySelector('[data-bench="hiddenLink"]') as HTMLElement).click()),
  ],
  'web-trap-label-button': [p => p.click('[data-bench="exportButton"]'), p => p.click('[data-bench="exportLabel"]')],
  'web-timing-late-dialog': [
    async p => { await p.click('#start'); await p.click('#download', { timeout: 8000 }); },
    async p => { await p.click('#start'); await p.waitForTimeout(300); },
  ],
  'web-timing-gated-field': [
    async p => {
      await p.click('#open');
      await p.waitForFunction(() => document.getElementById('editorStatus')!.textContent === 'Ready', undefined, { timeout: 8000 });
      await p.fill('#code', 'ORBIT-42');
      await p.click('#save');
    },
    // Typed at once: the field throws it away, and Save before Ready saves nothing.
    async p => { await p.click('#open'); await p.fill('#code', 'ORBIT-42'); await p.click('#save'); },
  ],
  'web-canvas-draw': [
    async p => { await drag(p, [120, 120], [520, 520]); },
    async p => { await drag(p, [120, 120], [520, 120]); },
  ],
  'web-canvas-targets': [
    async p => { for (const [x, y] of [[110, 100], [520, 130], [320, 320], [130, 530], [540, 500]]) await p.mouse.click(x, y); },
    async p => { for (const [x, y] of [[110, 100], [300, 100], [300, 500], [400, 400]]) await p.mouse.click(x, y); },
  ],
  'web-long-read': [
    async p => {
      const code = await p.locator('tr', { has: p.locator('td', { hasText: /^Delta-17$/ }) }).locator('td').nth(1).innerText();
      await p.fill('#answer', code);
      await p.click('#submit');
    },
    async p => { await p.fill('#answer', 'QX-4462-MX'); await p.click('#submit'); },
  ],
};

/** The canvas sits 20 px into the page: page coordinates here. */
async function drag(p: Page, from: [number, number], to: [number, number]): Promise<void> {
  await p.mouse.move(from[0], from[1]);
  await p.mouse.down();
  await p.mouse.move(to[0], to[1], { steps: 3 });
  await p.mouse.up();
}

export async function selfcheckWeb(log: (line: string) => void = console.log): Promise<boolean> {
  const tasks = loadTasks().filter(t => t.fixture.kind === 'web');
  const server = await startFixtureServer();
  // An installed browser, headless: no window, nothing takes the focus.
  const channel = process.platform === 'win32' ? 'msedge' : 'chrome';
  const browser = await chromium.launch({ channel, headless: true });
  let ok = true;
  try {
    for (const task of tasks) {
      const scripts = SCRIPTS[task.id];
      if (!scripts) { log(`FAIL ${task.id}: no selfcheck script`); ok = false; continue; }
      for (const [i, want] of [[0, true], [1, false]] as Array<[number, boolean]>) {
        const got = await runScript(task, scripts[i], `${task.id}-${i}`, server, browser);
        const pass = got.holds === want && (want ? got.events > 0 : true);
        if (!pass) ok = false;
        log(`${pass ? 'ok  ' : 'FAIL'} ${task.id} ${want ? 'right' : 'wrong'} trajectory: predicate ${got.holds}, ${got.events} events`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return ok;
}

async function runScript(task: TaskSpec, script: Script, run: string, server: Awaited<ReturnType<typeof startFixtureServer>>,
  browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<{ holds: boolean; events: number }> {
  if (task.fixture.kind !== 'web' || !task.success) throw new Error('not a web task');
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  try {
    await page.goto(server.url(task.fixture.page, run, task.fixture.query));
    await script(page);
    await page.waitForTimeout(400);  // the recorder posts 30 ms after an event and polls its state every 200 ms
    const fx = server.state(run);
    return { holds: evaluate(task.success, fx), events: fx.events.length };
  } finally {
    await page.close();
  }
}
