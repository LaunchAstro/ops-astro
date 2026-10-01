// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-1: the Work log's search must not loop its own read.
//
// The people in view decide how a word is read, the reading decides the
// ledger's `query`, and the answer to that query becomes the people in view.
// A word that is no one in the newest days goes to the ledger as a free word;
// if the days it finds were acted on by someone whose name holds that word,
// the word must not then turn into a person, drop the query, read the newest
// days again (where that person is not), turn back into a free word, and so on.

import { describe, expect, it } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { drawn, json, openWorkLog, pinZone, projects, tick } from './work-log-stand-in.tsx';

pinZone();

const ev = (id: string, actorName: string, key: string) => ({
  id,
  at: '2026-09-28T02:00:00Z',
  actorName,
  operation: 'task.update',
  task: { key, title: `Task ${key}` },
});

/** The newest days: Ada and Ben, no Dee. */
const NEWEST: TaskLedgerResult = {
  ok: true,
  days: [
    { day: '2026-09-28', events: [ev('a1', 'Ada Admin', 'OPS-1'), ev('b1', 'Ben Brown', 'OPS-2')] },
  ],
  earlier: true,
};

/** What C1's search finds for `dee`: days Dee Dunn acted on. */
const DEE: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-10', events: [ev('d1', 'Dee Dunn', 'OPS-9')] }],
  earlier: false,
};

/** A stand-in that answers every ledger read by its query, as often as asked. */
function routed() {
  const asked: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    const at = String(url);
    if (at.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (!at.endsWith('/task/ledger')) return Promise.reject(new Error(`unrouted ${at}`));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    asked.push(body);
    // Answered a turn later, as a network would: a loop then spins ask by
    // ask, where it can be counted, instead of starving the test's clock.
    const answer = json(body['query'] === 'dee' ? DEE : NEWEST);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(answer);
      }, 0);
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe('REVIEW-MAIN-2B1-1 the search does not feed its own reading', () => {
  it('REVIEW-MAIN-2B1-1: a word found as a person by its own search does not loop the read', async () => {
    const api = routed();
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);
    expect(api.asked).toHaveLength(1);

    await view.type('input[type="search"]', 'dee');
    for (let i = 0; i < 6; i += 1) await tick();
    const askedThen = api.asked.length;
    const drawnThen = drawn(view);
    for (let i = 0; i < 4; i += 1) await tick();

    // One read for the newest days, one for `dee`, and no more.
    expect(
      api.asked.length,
      `the ledger was asked ${String(api.asked.length)} times: ${JSON.stringify(api.asked.map((b) => b['query'] ?? null))}`,
    ).toBeLessThanOrEqual(2);
    // Settled: nothing more is asked and the rows stop changing.
    expect(api.asked.length).toBe(askedThen);
    expect(drawn(view)).toEqual(drawnThen);
    await view.unmount();
  });
});
