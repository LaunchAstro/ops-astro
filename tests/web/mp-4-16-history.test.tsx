// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-16 on the task page (DT-22, TT-05): the History head reads the latest
// change (how long ago, who, what), and the page shows the whole trail open.
// Transitions only: a comment is conversation, not a change to the task. An
// explicit empty line when nothing has changed. The panel's folded trail and
// its saved preference are MP-4-8's (the dock task panel).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { found, task, tick } from './task-page-stub.tsx';
import { json, mount, page, unmountAll } from './perspective-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const NOW = new Date('2026-09-29T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const at = (minutesAgo: number): string =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const HISTORY = [
  {
    at: at(3 * 24 * 60),
    actorId: 'actor-ada',
    actorName: 'Ada',
    actorKind: 'person',
    operation: 'task.create',
  },
  {
    at: at(120),
    actorId: 'actor-ada',
    actorName: 'Ada',
    actorKind: 'person',
    operation: 'task.comment',
  },
  {
    at: at(90),
    actorId: 'actor-ben',
    actorName: 'Ben',
    actorKind: 'person',
    operation: 'task.update',
  },
  {
    at: at(5),
    actorId: 'actor-ben',
    actorName: 'Ben',
    actorKind: 'person',
    operation: 'task.comment',
  },
];

const head = (view: Mounted): string | null =>
  view.find('[data-history="latest"]')?.textContent ?? null;

const rows = (view: Mounted): string[] =>
  view.all('[data-history="trail"] .sbact__row').map((row) => row.textContent ?? '');

describe('MP-4-16 latest change head', () => {
  it('the head reads how long ago, who and what of the latest change', async () => {
    const view = await page('Proj-Verity-Pacing', found({ history: HISTORY }));
    expect(head(view)).toBe('1 hour ago · Ben · Details changed');
  });
});

describe('MP-4-16 transitions only', () => {
  it('a comment is neither the latest change nor a row of the trail', async () => {
    const view = await page('Proj-Verity-Pacing', found({ history: HISTORY }));
    expect(rows(view)).toStrictEqual([
      '3 days ago · AdaCreated',
      '1 hour ago · BenDetails changed',
    ]);
  });
});

describe('MP-4-16 the page shows it open', () => {
  it('every change is listed, with nothing to fold it away', async () => {
    const view = await page('Proj-Verity-Pacing', found({ history: HISTORY }));
    expect(rows(view)).toHaveLength(2);
    expect(view.find('[data-history] button')).toBeNull();
  });
});

describe('MP-4-16 empty line on the page', () => {
  it('with nothing changed the page says so and the head has no latest change', async () => {
    const view = await page(
      'Proj-Verity-Pacing',
      found({
        history: [
          {
            at: at(1),
            actorId: 'actor-ada',
            actorName: 'Ada',
            actorKind: 'person',
            operation: 'task.comment',
          },
        ],
      }),
    );
    expect(head(view)).toBeNull();
    expect(view.find('[data-history="empty"]')?.textContent).toBe(
      'Nothing has changed on this one yet.',
    );
  });
});

describe('MP-4-16 a change on the page appears at once', () => {
  it('a lifecycle press rereads the task and its change heads the history', async () => {
    let history: unknown[] = HISTORY;
    const fetch = ((url: string | URL) => {
      const where = String(url);
      if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
      if (where.endsWith('/task/read')) {
        return Promise.resolve(json({ ok: true, task: task({ history }) }));
      }
      if (where.endsWith('/task/complete')) {
        history = [
          ...HISTORY,
          {
            at: at(0),
            actorId: 'actor-cai',
            actorName: 'Cai',
            actorKind: 'person',
            operation: 'task.complete',
          },
        ];
        return Promise.resolve(json({ recordId: 'x', revision: 5 }));
      }
      throw new Error(`unrouted ${where}`);
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({ origin: '', businessKey: 'alpha', token: 't', fetch });
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    await view.click('[data-lifecycle="complete"]');
    await tick();
    expect(head(view)).toBe('just now · Cai · Completed');
  });
});

describe('MP-4-16 visual match', () => {
  it.todo('matches the mockup at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});

describe('MP-4-16 who: the page names whoever made each change', () => {
  const NAMED = [
    {
      at: at(60),
      actorId: 'actor-ada',
      actorName: 'Ada Lovelace',
      actorKind: 'person',
      operation: 'task.create',
    },
    {
      at: at(30),
      actorId: 'actor-bot',
      actorName: null,
      actorKind: 'agent',
      operation: 'task.set_adhoc',
    },
    {
      at: at(10),
      actorId: 'actor-sys',
      actorName: null,
      actorKind: 'worker',
      operation: 'task.update',
    },
  ];

  it('a person by name, an agent and the system in words, and never an identifier', async () => {
    const view = await page('Proj-Verity-Pacing', found({ history: NAMED }));
    expect(head(view)).toBe('10 minutes ago · The system · Details changed');
    const trail = rows(view).join(' | ');
    expect(trail).toContain('Ada Lovelace');
    expect(trail).toContain('An agent');
    expect(view.find('[data-history]')?.parentElement?.textContent).not.toMatch(/actor-/u);
  });
});
