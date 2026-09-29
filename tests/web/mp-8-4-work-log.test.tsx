// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4 in the web application: the Projects page's Work log tab placing the
// ledger face over `task.ledger`, against a stand-in that answers the way the
// API does (`packages/core-commands/src/reads/ledger.ts`).
//
// "A tab reaches it": the Work log is a tab on `/projects/`, reached by
// `#worklog` as the mockup's `/projects/#worklog` is, and its read is made
// only once the tab is opened. Paging walks `before` back a page of whole days
// at a time; a page that arrives after the reader changed is dropped.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const event = (id: string, at: string, key: string, title: string) => {
  return { id, at, actorName: 'Ada Admin', operation: 'task.update', task: { key, title } };
};

const page = (
  days: readonly { day: string; events: ReturnType<typeof event>[] }[],
  earlier: boolean,
): TaskLedgerResult => ({ ok: true, days, earlier });

const FIRST = page(
  [
    { day: '2026-09-28', events: [event('e1', '2026-09-28T02:00:00Z', 'OPS-1', 'Fix the gate')] },
    { day: '2026-09-22', events: [event('e2', '2026-09-22T02:00:00Z', 'OPS-2', 'Paint the shed')] },
  ],
  true,
);

const SECOND = page(
  [{ day: '2026-09-15', events: [event('e3', '2026-09-15T02:00:00Z', 'OPS-3', 'Oil the hinge')] }],
  false,
);

const refused = (code: string, names: readonly string[]) => ({ refused: true, code, names });

/** An answer the test releases when it chooses. */
function held(): {
  readonly response: Promise<Response>;
  readonly release: (body: unknown) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return {
    response: promise,
    release: (body) => {
      resolve(json(body));
    },
  };
}

type Answer = { readonly body: unknown; readonly status?: number } | Promise<Response>;

/** Every ledger request's body, and the answers to give, in order. */
function server(ledger: Answer[]) {
  const asked: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    const at = String(url);
    if (at.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (!at.endsWith('/task/ledger')) return Promise.reject(new Error(`unrouted ${at}`));
    asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = ledger.shift();
    if (next === undefined) return Promise.reject(new Error('no ledger answer left'));
    return next instanceof Promise ? next : Promise.resolve(json(next.body, next.status ?? 200));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const opened: string[] = [];

const projects = (fetch: typeof globalThis.fetch, grantKey = 'alpha:owner') => (
  <Projects
    client={new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey={grantKey}
    navigate={(path) => {
      opened.push(path);
    }}
  />
);

// Pinned, so the fallback case is a fallback wherever the suite runs: a
// machine already in UTC would have nothing to fall back from.
const zone = 'Australia/Brisbane';
let tz: string | undefined;

beforeEach(() => {
  tz = process.env['TZ'];
  process.env['TZ'] = zone;
});

afterEach(() => {
  if (tz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = tz;
  opened.length = 0;
  window.history.replaceState(null, '', '/projects/');
});

const TAB = '[data-tabs="projects"] [role="tab"]';

const openWorkLog = async (view: Awaited<ReturnType<typeof mount>>): Promise<void> => {
  await view.click(`${TAB}:nth-child(2)`);
  await tick();
};

const drawn = (view: Awaited<ReturnType<typeof mount>>): readonly (string | undefined)[] =>
  view.all('.act__row').map((row) => (row as HTMLElement).dataset['event']);

describe('MP-8-4 a tab reaches it', () => {
  it('the Projects page carries a Work log tab, and its read waits until the tab is opened', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();

    const tabs = view.all(TAB).map((t) => t.textContent);
    expect(tabs).toEqual(['Board', 'Work log']);
    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Board');
    expect(api.asked).toHaveLength(0);
    expect(view.all('.act__row')).toHaveLength(0);

    await openWorkLog(view);
    expect(api.asked).toEqual([{ timeZone: zone, before: null }]);
    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
    expect(drawn(view)).toEqual(['e1', 'e2']);
    expect(window.location.hash).toBe('#worklog');
    await view.unmount();
  });

  it('`/projects/#worklog` opens on the Work log', async () => {
    window.history.replaceState(null, '', '/projects/#worklog');
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();

    expect(view.find('[role="tab"][aria-selected="true"]')?.textContent).toBe('Work log');
    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(2);
    await view.unmount();
  });

  it('back on the Board, the Work log keeps what it drew and reads nothing again', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);
    await view.click(`${TAB}:nth-child(1)`);
    await openWorkLog(view);

    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(2);
    expect(window.location.hash).toBe('#worklog');
    await view.unmount();
  });
});

describe('MP-8-4 rows open the task (web)', () => {
  it('a plain press on a row goes to that task’s own address', async () => {
    const api = server([{ body: FIRST }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('[data-event="e2"] .act__text');
    expect(opened).toEqual(['/task/OPS-2']);
    expect(view.find('[data-event="e1"] a')?.getAttribute('href')).toBe('/task/OPS-1');
    await view.unmount();
  });
});

describe('MP-8-4 paging per the long-lists ruling (web)', () => {
  it('Load earlier days asks for the days before the last one drawn and adds them below', async () => {
    const api = server([{ body: FIRST }, { body: SECOND }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await tick();
    expect(api.asked[1]).toEqual({ timeZone: zone, before: '2026-09-22' });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(view.find('.act__more')).toBeNull();
    await view.unmount();
  });

  it('an earlier page that fails says so and keeps the days already drawn', async () => {
    const api = server([
      { body: FIRST },
      { body: refused('SCOPE_NOT_GRANTED', ['task']), status: 403 },
    ]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await tick();
    expect(view.all('.act__row')).toHaveLength(2);
    expect(view.find('[data-ledger-more="failed"]')?.getAttribute('role')).toBe('alert');
    expect(view.find('.act__more')).not.toBeNull();
    await view.unmount();
  });
});

describe('MP-8-4 paging per the long-lists ruling (web), races', () => {
  it('a second press while a page is on its way asks once', async () => {
    const later = held();
    const api = server([{ body: FIRST }, later.response]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.click('.act__more');
    await view.click('.act__more');
    later.release(SECOND);
    await tick();
    expect(api.asked).toHaveLength(2);
    expect(view.all('.act__row')).toHaveLength(3);
    await view.unmount();
  });

  it('a page that arrives after the reader changed is dropped, not drawn under the new reader', async () => {
    const later = held();
    const api = server([{ body: FIRST }, later.response, { body: page([], false) }]);
    const view = await mount(projects(api.fetch, 'alpha:owner'));
    await tick();
    await openWorkLog(view);
    await view.click('.act__more');

    await view.render(projects(api.fetch, 'alpha:other'));
    await tick();
    later.release(SECOND);
    await tick();

    expect(api.asked).toHaveLength(3);
    expect(api.asked[2]).toEqual({ timeZone: zone, before: null });
    expect(view.all('.act__row')).toHaveLength(0);
    expect(view.text()).not.toContain('Oil the hinge');
    await view.unmount();
  });
});

describe('MP-8-4 the reader’s zone (web)', () => {
  it('a zone the server does not know falls back to UTC, and the days are drawn in it', async () => {
    const api = server([
      { body: refused('FIELD_VALUE_INVALID', ['timeZone']), status: 400 },
      { body: FIRST },
      { body: SECOND },
    ]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    expect(api.asked.map((body) => body['timeZone'])).toEqual([zone, 'UTC']);
    expect(view.all('.act__row')).toHaveLength(2);
    expect(view.find('[data-event="e1"] .act__t')?.textContent).toBe('02:00');

    await view.click('.act__more');
    await tick();
    expect(api.asked[2]).toEqual({ timeZone: 'UTC', before: '2026-09-22' });
    await view.unmount();
  });

  it('any other refusal is drawn as a refusal, with no rows and no second try', async () => {
    const api = server([{ body: refused('NOT_FOUND', ['task']), status: 404 }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    expect(api.asked).toHaveLength(1);
    expect(view.all('.act__row')).toHaveLength(0);
    expect(view.text()).toContain('You are not permitted to see this work log.');
    await view.unmount();
  });
});
