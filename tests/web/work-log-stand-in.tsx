// SPDX-License-Identifier: AGPL-3.0-only
//
// The stand-in API and the page for the MP-8-4 Work log tests
// (`mp-8-4-work-log*.test.tsx`).
//
// MP-8-4 in the web application: the Projects page's Work log tab placing the
// ledger face over `task.ledger`, against a stand-in that answers the way the
// API does (`packages/core-commands/src/reads/ledger.ts`).
//
// "A tab reaches it": a tab on `/projects/`, reached by `#worklog` as in the
// mockup, reading only once opened. Paging walks `before` back a page of
// whole days at a time; a page that arrives after the reader changed is dropped.

import { act } from 'react';
import { afterEach, beforeEach } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';

export const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const event = (id: string, at: string, key: string, title: string) => {
  return { id, at, actorName: 'Ada Admin', operation: 'task.update', task: { key, title } };
};

export const page = (
  days: readonly { day: string; events: ReturnType<typeof event>[] }[],
  earlier: boolean,
): TaskLedgerResult => ({ ok: true, days, earlier });

export const FIRST = page(
  [
    { day: '2026-09-28', events: [event('e1', '2026-09-28T02:00:00Z', 'OPS-1', 'Fix the gate')] },
    { day: '2026-09-22', events: [event('e2', '2026-09-22T02:00:00Z', 'OPS-2', 'Paint the shed')] },
  ],
  true,
);

export const SECOND = page(
  [{ day: '2026-09-15', events: [event('e3', '2026-09-15T02:00:00Z', 'OPS-3', 'Oil the hinge')] }],
  false,
);

/** SECOND with more before it, and the page before that. */
export const SECOND_OF_THREE: TaskLedgerResult = { ...SECOND, earlier: true };
export const THIRD = page(
  [{ day: '2026-09-08', events: [event('e4', '2026-09-08T02:00:00Z', 'OPS-4', 'Sweep the yard')] }],
  false,
);

export const refused = (code: string, names: readonly string[]) => ({
  refused: true,
  code,
  names,
  fixes: [],
});

/** An answer the test releases when it chooses. */
export function held(): {
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
export function server(ledger: Answer[]) {
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

export const opened: string[] = [];

export const projects = (fetch: typeof globalThis.fetch, grantKey = 'alpha:owner') => (
  <Projects
    client={new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey={grantKey}
    navigate={(path) => {
      opened.push(path);
    }}
  />
);

// Pinned: on a machine already in UTC there is nothing to fall back from.
export const zone = 'Australia/Brisbane';

/** Each case in `zone`, with no address or opened task left for the next. */
export function pinZone(): void {
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
}

export const TAB = '[data-tabs="projects"] [role="tab"]';

export const openWorkLog = async (view: Awaited<ReturnType<typeof mount>>): Promise<void> => {
  await view.click(`${TAB}:nth-child(2)`);
  await tick();
};

export const drawn = (view: Awaited<ReturnType<typeof mount>>): readonly (string | undefined)[] =>
  view.all('.act__row').map((row) => (row as HTMLElement).dataset['event']);
