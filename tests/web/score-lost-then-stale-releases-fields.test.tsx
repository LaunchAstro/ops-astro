// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A score edit whose answer was lost, retried under the same id and answered
// VERSION_STALE, was never stored: the server replays a stored success before
// it checks the revision. So the stale answer settles the hold.
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { refusal } from './internal-task-mentions-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';

it('A lost score edit answered VERSION_STALE on retry releases the score fields', async () => {
  const server = marksWorld();
  const writes: unknown[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (!String(url).endsWith('/task/set_scores')) return server.fetch(url, init);
    writes.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      writes.length === 1
        ? new Response('lost before apply', { status: 503 })
        : refusal('VERSION_STALE'),
    );
  };
  const app = await realm(fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', true);
  await app.view.click('[data-score-retry]');
  await app.tick();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(app.view.text()).toContain('VERSION_STALE');
  expect(app.view.find('[data-score-retry]')).toBeNull();
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', false);
  expect(app.storage.getItem('ops-astro.task-scores')).not.toContain(
    String((writes[0] as { operationId: string }).operationId),
  );
});
