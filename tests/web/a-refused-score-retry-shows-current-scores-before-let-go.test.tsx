// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A score change stored before its answer was lost, then retried and refused,
// is offered Stop waiting. The page reads the task again first, so the person
// decides with the scores as they now are, not as they were before the change.
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';

const impact = (text: string | null | undefined): string => text?.replaceAll(/\s+/gu, ' ') ?? '';

it('a refused score retry shows the current scores before the person lets it go', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  server.deny(true);
  await app.view.click('[data-score-retry]');
  await app.tick();
  await app.tick();
  expect(server.effects()).toBe(1);
  const letGo = app.view
    .all('button')
    .find((one) => one.textContent === 'Stop waiting for this change');
  expect(letGo, 'Stop waiting is offered after the refused retry').toBeDefined();
  expect(impact(app.view.find('#page-score-impact button')?.textContent)).toContain('10');
});

async function ticks(tick: () => Promise<void>): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- one tick at a time
    await tick();
  }
}

it('each refused score retry reads the task again once, never in a loop', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  server.deny(true);
  const reads = (): number => server.sent.filter((one) => one.path === '/task/read').length;
  const before = reads();
  await app.view.click('[data-score-retry]');
  await ticks(app.tick);
  expect(reads(), 'one read for the refusal').toBe(before + 1);
  await app.view.click('[data-score-retry]');
  await ticks(app.tick);
  expect(reads(), 'one more for the second refusal').toBe(before + 2);
  expect(server.effects()).toBe(1);
});
