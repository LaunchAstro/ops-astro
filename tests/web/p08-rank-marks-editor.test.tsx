// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { realm } from './task-timer-recovery-support.tsx';
import { draftTab } from './projects-draft-app-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';
import { houseOptions } from './p08-rank-marks-select-support.tsx';

it('page and panel use independently labelled house menus with exactly nullable whole1–10 choices and Escape', async () => {
  const server = marksWorld();
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await app.view.click('main [data-panel-door="open"]');
  const page = app.view.host.querySelector<HTMLButtonElement>('#page-score-confidence button');
  const panel = app.view.host.querySelector<HTMLButtonElement>('#panel-score-confidence button');
  expect(page?.id).not.toBe(panel?.id);
  expect(page?.getAttribute('aria-haspopup')).toBe('listbox');
  expect(panel?.getAttribute('aria-haspopup')).toBe('listbox');
  expect(await houseOptions(page)).toEqual([
    { value: '', text: 'Not set', disabled: false, selected: false },
    ...Array.from({ length: 10 }, (_, index) => ({
      value: String(index + 1),
      text: String(index + 1),
      disabled: false,
      selected: index + 1 === 9,
    })),
  ]);
  expect(page?.getAttribute('aria-expanded')).toBe('false');
  expect(server.writes()).toEqual([]);
  expect(server.unexpected).toEqual([]);
});

it('unsaved task title keeps score controls disabled without discarding the draft', async () => {
  const server = marksWorld();
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await app.view.type('#task-title', 'Unsaved operator words');
  expect(app.view.find('#page-score-impact button')).toHaveProperty('disabled', true);
  await app.view.click('#page-score-impact button');
  expect(server.writes()).toEqual([]);
  expect(app.view.find('#task-title')).toHaveProperty('value', 'Unsaved operator words');
  expect(server.unexpected).toEqual([]);
});

it.each(['missing', 'delegated'] as const)(
  '%s detail never reconstructs raw marks from a rank calculation',
  async (mode) => {
    const server = marksWorld();
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const answer = await server.fetch(url, init);
      if (!String(url).endsWith('/task/read')) return answer;
      const result = await answer.json();
      Reflect.deleteProperty(result.task, mode === 'missing' ? 'scores' : 'client');
      return Response.json(result);
    };
    const app = await realm(fetch, draftTab(), '/task/' + KEY);
    expect(app.view.text()).toContain('Budget pacing fix');
    expect(app.view.find('#page-score-impact button')).toBeNull();
    expect(server.writes()).toEqual([]);
    expect(server.unexpected).toEqual([]);
  },
);

it('fresh authority refusal is a known answer, retains displayed marks and never claims an uncertain prior write', async () => {
  const server = marksWorld();
  server.deny(true);
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  expect(server.writes()).toHaveLength(1);
  expect(server.effects()).toBe(0);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).not.toContain('may already have been stored');
  expect(app.view.find('[data-score-retry]')).toBeNull();
  expect(app.view.find('#page-score-impact button')).toHaveProperty('textContent', '7');
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', true);
  expect(server.unexpected).toEqual([]);
});
