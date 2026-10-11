// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- one browser must finish each action before the next state. */
// Captures interaction states using the real app and isolated synthetic reads.
// All writes are intercepted. Nothing reaches the local API or publishes.
// Usage: node tests/visual/projects-task-states.ts --out .local/visual-parity/states
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChromium } from '../support/chromium.ts';
import { serveApp } from './app-pages.ts';
import { captureAgentDetails, captureInvalidTitle } from './task-deep-states.ts';
import { taskControlSurfaces } from './task-control-surfaces.ts';
import { sweepControls } from './control-sweep.ts';
import { DETAIL, STATE } from './made-up-rows.ts';
import { answerMadeUp } from './made-up-api.ts';
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1] ?? '.local/visual-parity/states';
const focusAt = args.indexOf('--surface');
const focus = focusAt === -1 ? undefined : args[focusAt + 1]?.split(',');
mkdirSync(out, { recursive: true });
writeFileSync(
  `${out}/candidate.json`,
  JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
      viewport: { width: 2048, height: 1038 },
      writes: 'intercepted and refused',
      source: 'isolated synthetic reads',
    },
    null,
    2,
  ),
);
const served = await serveApp();
const browser = await launchChromium({ headless: true });
const context = await browser.newContext({
  viewport: { width: 2048, height: 1038 },
  deviceScaleFactor: 1,
});
await context.addInitScript(() => {
  sessionStorage.clear();
  sessionStorage.setItem(
    'ops-astro.session',
    JSON.stringify({
      businessKey: 'alpha',
      email: 'a@example.invalid',
      sessionId: 'synthetic-visual-parity',
    }),
  );
});
await context.route('**/api/**', (route) =>
  route.fulfill({
    status: 403,
    json: { refused: true, code: 'SYNTHETIC_CAPTURE_WRITE_BLOCKED', names: [], fixes: [] },
  }),
);
await answerMadeUp(context);
await context.route('**/api/sign-in', (route) =>
  route.fulfill({ json: { issuer: 'http://127.0.0.1:9/auth/v1' } }),
);
let taskVariant: 'normal' | 'empty' | 'assignable' = 'normal';
await context.route('**/api/b/*/task/read', async (route) => {
  if (taskVariant === 'normal') {
    await route.fallback();
    return;
  }
  await route.fulfill({
    json: {
      ok: true,
      task: {
        ...DETAIL,
        ...(taskVariant === 'empty'
          ? { hasContent: false }
          : {
              myAgents: [
                { agentId: '00000000-0000-4000-8000-000000000081', name: 'Copy executor' },
                { agentId: '00000000-0000-4000-8000-000000000082', name: 'Page reviewer' },
              ],
            }),
      },
      states: Object.values(STATE),
    },
  });
});
const page = await context.newPage();
const errors: string[] = [];
const states: unknown[] = [];
let failure: string | null = null;
page.on('pageerror', (error) => errors.push(error.message));
async function capture(name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
  const inventory = await page
    .locator('button,a,input,textarea,summary,[role=tab],[role=checkbox],[role=separator]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return [];
        const css = getComputedStyle(element);
        return [
          {
            tag: element.tagName,
            name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
            id: element.id,
            attributes: Object.fromEntries(
              [...element.attributes]
                .filter((attribute) => attribute.name.startsWith('data-'))
                .map((attribute) => [attribute.name, attribute.value]),
            ),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            font: css.font,
            colour: css.color,
            background: css.backgroundColor,
            padding: css.padding,
          },
        ];
      }),
    );
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  await page.screenshot({ path: `${out}/${name}.png` });
  writeFileSync(`${out}/${name}.json`, JSON.stringify({ metrics, inventory }, null, 2));
  states.push({ name, ...metrics, controls: inventory.length });
}
async function click(selector: string) {
  await page.locator(selector).first().click();
}
async function openDrawer(variant: typeof taskVariant = 'normal') {
  taskVariant = variant;
  await page.goto(new URL('/projects/', served.app).href);
  await page.locator('tr[data-row]').first().locator('td').first().click();
  await page.locator('[data-task-panel] .sb__name').waitFor();
}
try {
  if (focus === undefined) {
    await page.goto(new URL('/projects/', served.app).href);
    await page.locator('tr[data-row]').first().waitFor();
    await capture('board');
    await click('[data-funnel]');
    await capture('board-filters');
    await page.keyboard.press('Escape');
    await page.locator('[data-board-search]').fill('Meridian');
    await capture('board-typeahead');
    await page.keyboard.press('Escape');
    await openDrawer();
    await capture('task-team');
    for (const name of ['assignee', 'estimate', 'board', 'category', 'stage', 'status']) {
      const trigger = page.locator(`[id="panel-field-${name}-control"]`);
      if ((await trigger.count()) === 0) throw new Error(`Missing ${name} dropdown`);
      if (await trigger.isDisabled()) {
        states.push({ name: `task-${name}`, disabled: true });
        continue;
      }
      await trigger.click();
      await capture(`task-${name}-menu`);
      await page.keyboard.press('Escape');
    }
    await click('[data-panel-field=due]');
    await capture('task-calendar');
    await page.keyboard.press('Escape');
    const tag = page.locator('[data-task-panel] [role=combobox]');
    await tag.focus();
    await capture('task-tags');
    await page.keyboard.press('Escape');
    await click('.dtp__scores summary');
    await capture('task-priority');
    await click('.dtp__scores summary');
    const lock = page.locator('.dtp__client .field-callout summary');
    await lock.hover();
    await capture('task-client-lock');
    await page.mouse.move(800, 500);
    const body = page.locator('#panel-comment-body');
    await body.fill('@');
    await capture('task-mention-menu');
    await body.press('ArrowDown');
    await body.press('Enter');
    await capture('task-selected-mention');
    await body.fill('');
    await page.locator('[data-comment-id]').first().hover();
    await capture('task-comment-hover');
    await click('[data-comment-act=edit]');
    await capture('task-comment-edit');
    await page.keyboard.press('Escape');
    await click('[data-comment-act=reply]');
    await capture('task-comment-reply');
    await click('[data-task-panel] [data-comments=section] [role=tab][id$=client]');
    await capture('task-client-comments');
    await click('[data-task-panel] [data-comments=section] [role=tab][id$=all]');
    await capture('task-all-activity');
    await page.locator('[data-time-entry]').first().hover();
    await capture('task-time-hover');
    await click('[data-time-note]');
    await capture('task-time-note');
    await page.keyboard.press('Escape');
    await page.locator('[data-step]').first().hover();
    await capture('task-subtask-hover');
    await page
      .getByRole('tab', { name: /^Agent/u })
      .last()
      .click();
    await capture('task-agent');
    await captureAgentDetails(page, '.dpanel__body', capture, 'task-agent');
    await page.locator('[data-act=door]').last().click();
    await capture('task-page');
    await captureInvalidTitle(page, capture);
    await page.locator('#perspective-tab-agent').waitFor();
    await page.locator('#perspective-tab-agent').click();
    await capture('task-page-agent');
    await captureAgentDetails(page, '.content', capture, 'task-page-agent');
    for (const id of ['notifs', 'ai', 'clients', 'todos']) {
      await page.goto(new URL('/projects/', served.app).href);
      await click(`.dock__tab[data-panel=${id}]`);
      await capture(`sidebar-${id}`);
    }
    await page.goto(new URL('/projects/', served.app).href);
    await click('[data-projects-new-task]');
    await capture('task-draft');
  }
  const surfaces = taskControlSurfaces({
    page,
    app: served.app,
    openDrawer,
    reset: () => {
      taskVariant = 'normal';
    },
  });
  await sweepControls({
    page,
    out,
    capture,
    surfaces: focus === undefined ? surfaces : surfaces.filter(([name]) => focus.includes(name)),
  });
  if (focus === undefined) {
    for (const width of [1440, 1024, 900, 390]) {
      await page.setViewportSize({ width, height: 1038 });
      await page.goto(new URL('/projects/', served.app).href);
      await click('[data-projects-new-task]');
      await capture(`task-draft-${width}`);
      await page.goto(new URL('/projects/', served.app).href);
      await capture(`board-${width}`);
      await click('[data-funnel]');
      await capture(`board-funnel-${width}`);
      const inside = await page.locator('.cbd__menu').evaluate((menu) => {
        const rect = menu.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      });
      if (!inside) throw new Error(`Filter menu is outside the viewport at ${String(width)}`);
      await page.keyboard.press('Escape');
      await openDrawer();
      await capture(`task-team-${width}`);
      await page
        .getByRole('tab', { name: /^Agent/u })
        .last()
        .click();
      await capture(`task-agent-${width}`);
      await page.locator('[data-act=door]').last().click();
      await page.locator('#perspective-tab-team').waitFor();
      if (await page.locator('.dock[data-mode=floating][data-open="1"]').count())
        await click('.dock [data-act=close]');
      await capture(`task-page-team-${width}`);
      await page.getByLabel('Edit task details', { exact: true }).click();
      await capture(`task-page-editor-${width}`);
      const editorInside = await page.locator('.task-controls__body').evaluate((editor) => {
        const rect = editor.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth && rect.width >= Math.min(280, innerWidth - 64)
        );
      });
      if (!editorInside) throw new Error(`Task editor is outside the viewport at ${String(width)}`);
      await page.keyboard.press('Escape');
      await page.locator('#perspective-tab-agent').click();
      await capture(`task-page-agent-${width}`);
    }
  }
} catch (error) {
  failure = String(error);
  await capture('failure');
  writeFileSync(
    `${out}/failure.txt`,
    `${String(error)}\n${await page.locator('body').innerText()}`,
  );
  throw error;
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify({ states, errors, failure }, null, 2));
  await browser.close();
  await served.close();
}
if (errors.length > 0) throw new Error(`Browser errors: ${errors.join('; ')}`);
