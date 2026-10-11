// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1229: coming back to the tab must not reload the page. Being shown again
// re-reads every live topic and the rollup floor (C4), and a re-read publishes
// `loading`. A display that drew `loading` as its loading line, or a kept
// empty answer that drew nothing, swapped the page for one line and back, so
// the page flashed and the browser, with less left to scroll, moved the
// reader. The re-read now updates the page in place: the last answer stays
// drawn, in the same nodes, until the next one lands. jsdom draws no layout,
// so the nodes kept are the proof the browser has no reason to move the
// scroll; the scroll offset is checked too. A vocabulary a person sends from
// (the assignee and mention lists) still hides while it refreshes, so nobody
// is offered a person whose access may have gone.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { json, open, settle } from './mp-2-1-support.tsx';

const ADA = { personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Ada Park' };
const COSTS = {
  ok: true,
  period: { from: '2026-08-31T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
  runs: [
    {
      runId: 'r-1',
      taskId: 't-1',
      agentActorId: 'a-1111aaaa-0000',
      attachment: { kind: 'agency' },
      currency: 'AUD',
      cost: '1234',
      unpriced: null,
      startedAt: '2026-09-20T01:00:00.000Z',
      models: { ids: ['claude-haiku-4-5-20251001'], unnamedCalls: 0 },
    },
  ],
  byAgent: [],
  byAttachment: [],
};

/** The answer each route gives; the live stream stays open and silent. */
function answerFor(at: string): unknown {
  if (at.endsWith('/task/board')) {
    return { ok: true, tasks: [], changedAt: null, viewer: ADA.personId, withheld: 0 };
  }
  if (at.endsWith('/person/list')) return { ok: true, persons: [ADA] };
  if (at.endsWith('/finance/agent_costs')) return COSTS;
  return { ok: true };
}

/**
 * Answers each route's first read at once and holds every later one in
 * flight, as a slow network holds it, so the page is caught mid re-read.
 */
function server(): { readonly fetch: typeof globalThis.fetch; readonly rereads: () => number } {
  const seen = new Map<string, number>();
  const held: unknown[] = [];
  const fetch = ((url: string) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) return new Promise<Response>(() => {});
    const reads = (seen.get(at) ?? 0) + 1;
    seen.set(at, reads);
    if (reads === 1) return Promise.resolve(json(answerFor(at)));
    held.push(at);
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  return { fetch, rereads: () => held.length };
}

const flushed = async (): Promise<void> => {
  for (let pass = 0; pass < 10; pass += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass flushes the next hop
    await settle();
  }
};

/** Another tab, then this one again. */
async function tabReturn(): Promise<void> {
  for (const shown of ['hidden', 'visible'] as const) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: shown });
    // eslint-disable-next-line no-await-in-loop, require-await -- one flip at a time, effects flushed
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  await flushed();
}

const opened: Mounted[] = [];
afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    await page.unmount();
  }
  Reflect.deleteProperty(document, 'visibilityState');
  document.documentElement.scrollTop = 0;
});

const loadingLines = (page: Mounted): readonly string[] =>
  page.all('[data-outcome="loading"][role="status"]').map((each) => each.textContent);

describe('coming back to the tab keeps the page as it was drawn', () => {
  it('an empty Projects board re-reads in place: its empty voice stays drawn', async () => {
    const answers = server();
    const { view } = await open('/projects/', { fetch: answers.fetch });
    opened.push(view);
    await flushed();
    document.documentElement.scrollTop = 640;
    const none = view.find('[data-voice="no-rows"] .empty__title');
    expect(none?.textContent).toBe('No tasks on this board yet.');

    await tabReturn();

    expect(answers.rereads(), 'the return re-read the board').toBeGreaterThan(0);
    expect(loadingLines(view), 'nothing swapped to a loading line').toEqual([]);
    expect(view.find('[data-voice="no-rows"] .empty__title'), 'the same empty voice').toBe(none);
    expect(document.documentElement.scrollTop).toBe(640);
  });

  it('a page drawn whole from one read (Executive, on the rollup floor) keeps its rows', async () => {
    const answers = server();
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: answers.fetch,
    });
    const page = await mount(
      SCREENS['agency:executive']({
        client,
        grantKey: 'alpha:a@x:0',
        params: {},
        notice: null,
        storage: null,
        navigate: () => {},
      }),
    );
    opened.push(page);
    await flushed();
    document.documentElement.scrollTop = 640;
    const row = page.find('[data-cost-run="r-1"]');
    expect(row).not.toBeNull();

    await tabReturn();

    expect(answers.rereads(), 'the return re-read the costs').toBe(1);
    expect(loadingLines(page), 'nothing swapped to a loading line').toEqual([]);
    expect(page.find('[data-cost-run="r-1"]'), 'the same row node').toBe(row);
    expect(document.documentElement.scrollTop).toBe(640);
  });
});
