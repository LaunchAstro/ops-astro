// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1404 (round 1), retitled by what they prove; their bodies are as written.
import { expect, it } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { drawn, openWorkLog, pinZone, projects, server, tick } from './work-log-stand-in.tsx';

pinZone();

const page = (id: string, actorName: string) => ({
  ok: true,
  days: [
    {
      day: '2026-09-28',
      events: [
        {
          id,
          at: '2026-09-28T02:00:00Z',
          actorName,
          operation: 'task.update',
          task: { key: `OPS-${id}`, title: 'Ada hinge' },
        },
      ],
    },
  ],
  earlier: false,
});

it('an unchanged person search cannot admit a newly returned namesake', async () => {
  const api = server([{ body: page('a1', 'Ada Admin') }, { body: page('b9', 'Ada Brown') }]);
  const view = await mount(projects(api.fetch));
  await tick();
  await openWorkLog(view);
  await view.type('input[type="search"]', 'Ada hinge');
  await tick();
  await tick();
  expect(api.asked.map((body) => body['query'] ?? null)).toEqual([null, 'hinge']);
  expect(view.find('[data-ledger-read]')?.textContent).toBe(
    'Reading this as Ada Admin · the words “hinge” — 0 of them',
  );
  expect(drawn(view)).not.toContain('b9');
});

it('visiting an empty reader clears the previous actor vocabulary before returning', async () => {
  const api = server([
    { body: page('a1', 'Ada Admin') },
    { body: { ok: true, days: [], earlier: false } },
    { body: page('b9', 'Ben Brown') },
    { body: page('b9', 'Ben Brown') },
  ]);
  const view = await mount(projects(api.fetch, 'alpha:owner'));
  await tick();
  await openWorkLog(view);
  await view.render(projects(api.fetch, 'alpha:other'));
  await tick();
  expect(drawn(view)).toEqual([]);
  await view.render(projects(api.fetch, 'alpha:owner'));
  await tick();
  expect(drawn(view)).toEqual(['b9']);
  await view.type('input[type="search"]', 'Ada');
  await tick();
  expect(api.asked.map((body) => body['query'] ?? null)).toEqual([null, null, null, 'ada']);
  expect(view.find('[data-ledger-read]')?.textContent).not.toContain('Ada Admin');
});
