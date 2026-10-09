// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import { draftTab } from './projects-draft-app-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';

it('actual App exposes structured nullable marks in the page and sends only the selected mark at its read revision', async () => {
  const server = marksWorld();
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  expect(app.view.find('#page-score-impact button')).not.toBeNull();
  await chooseMark(app.view, 'page', 'confidence', '');
  expect(server.writes()).toHaveLength(1);
  expect(server.writes()[0]?.body).toMatchObject({
    expectedRevision: 4,
    fields: { confidence: null },
  });
  expect(server.writes()[0]?.body['operationId']).toEqual(expect.any(String));
  expect(app.view.find('#page-score-impact button')).toHaveProperty('textContent', '7');
  expect(app.view.find('#page-score-confidence button')).toHaveProperty('textContent', 'Not set');
  expect(app.view.find('#page-score-ease button')).toHaveProperty('textContent', '8');
  expect(server.unexpected).toEqual([]);
});

it.each(['lost-before', 'lost-after'] as const)(
  'actual App F5 retains exact %s score identity and only explicit retry reconciles it',
  async (mode) => {
    const server = marksWorld(mode);
    const first = await realm(server.fetch, draftTab(), '/task/' + KEY);
    expect(first.view.find('#page-score-impact button')).not.toBeNull();
    await chooseMark(first.view, 'page', 'impact', '10');
    const original = server.writes()[0]?.body;
    expect(first.view.find('[data-score-retry]')).not.toBeNull();
    const storage = copied(first.storage);
    await first.view.unmount();
    const next = await realm(server.fetch, storage, '/task/' + KEY);
    expect(server.writes()).toHaveLength(1);
    expect(next.view.find('[data-score-retry]')).not.toBeNull();
    if (mode === 'lost-after') {
      server.deny(true);
      await next.view.click('[data-score-retry]');
      expect(server.writes()[1]?.body).toEqual(original);
      expect(next.view.text()).toContain('SCOPE_NOT_GRANTED');
      expect(next.view.find('[data-score-retry]')).not.toBeNull();
      server.deny(false);
    }
    await next.view.click('[data-score-retry]');
    expect(server.writes().at(-1)?.body).toEqual(original);
    expect(server.effects()).toBe(1);
    expect(next.view.find('[data-score-retry]')).toBeNull();
    expect(server.unexpected).toEqual([]);
  },
);

it('actual page and panel share one unresolved score attempt and retry the original page envelope', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  expect(app.view.find('#page-score-impact button')).not.toBeNull();
  await chooseMark(app.view, 'page', 'impact', '10');
  const original = server.writes()[0]?.body;
  await app.view.click('main [data-panel-door="open"]');
  expect(app.view.find('#panel-score-ease button')).toHaveProperty('disabled', true);
  expect(server.writes()).toHaveLength(1);
  await app.view.click('[data-task-panel] [data-score-retry]');
  expect(server.writes()[1]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(app.view.find('#page-score-impact button')).toHaveProperty('textContent', '10');
  expect(app.view.find('#panel-score-impact button')).toHaveProperty('textContent', '10');
  expect(server.unexpected).toEqual([]);
});
