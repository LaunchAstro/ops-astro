// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): every owed run is read back each pass, one read at
// a time. A store that answers no read is read no more that pass after a few
// tries, so a long owed list does not hold the pass, and the businesses after
// it, for a timeout per run. One trace that never answers hides nothing after
// it, and after a delete every run of the page is still read.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_store_silent');

/** Exported runs aged past the window. */
async function agedRuns(
  label: string,
  count: number,
): Promise<Awaited<ReturnType<typeof liveWork>>[]> {
  const works = [];
  for (let n = 0; n < count; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    works.push(await liveWork(t.alpha, `${label} ${String(n)}`, 1000));
  }
  await drain(t.alpha);
  for (const work of works) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    await age(String(work.picked['runId']), TRACE_WINDOW_DAYS + 1);
  }
  return works;
}

/** A read port that answers `unknown` for the reads `silent` picks, counting every read. */
function reading(silent: (read: number) => boolean): { ports: ExpiryPorts; reads: () => number } {
  let reads = 0;
  return {
    ports: {
      expire: (ids) => t.target.expiry.expire(ids),
      present: (traceId) => {
        reads += 1;
        return silent(reads)
          ? Promise.resolve('unknown' as const)
          : t.target.expiry.present(traceId);
      },
    },
    reads: () => reads,
  };
}

it.skipIf(noDatabase)(
  'Trace retention: a silent store is read three times, one silent trace hides no later owed run',
  async () => {
    // Four runs asked, their deletes timing out, then each takes a fresh handback: four owed asks.
    const works = await agedRuns('trace retention silent store', 4);
    const timeout: ExpiryPorts = {
      expire: () => Promise.resolve({ ok: false, fault: 'timeout', status: null }),
      present: t.target.expiry.present,
    };
    const asked = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, timeout);
    expect(asked.at(-1)).toMatchObject({ runs: 4, code: 'target_timeout' });
    for (const work of works) {
      // eslint-disable-next-line no-await-in-loop -- one handback after another
      const answer = await asAgent(
        t.alpha,
        handbackBody(work.picked),
        String(work.picked['credential']),
      );
      expect(codeOf(answer)).toBe('applied');
    }
    await drain(t.alpha);

    // The store answers no read: three reads, then the pass stops.
    const silent = reading(() => true);
    expect(await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, silent.ports)).toEqual([]);
    expect(silent.reads(), 'a store that answers no read is read three times').toBe(3);

    // Only the first trace never answers: every owed run is still read.
    const one = reading((read) => read === 1);
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, one.ports);
    expect(one.reads(), 'one silent trace hides no later owed run').toBe(4);
  },
);

it.skipIf(noDatabase)(
  'Trace retention: after a delete, one unanswered read does not stop the rest of the page',
  async () => {
    await agedRuns('trace retention silent read after delete', 2);
    const first = reading((read) => read === 1);
    const passes = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, first.ports);
    expect(passes[0], 'the page is read whole after its delete').toMatchObject({
      runs: 2,
      confirmed: 1,
      code: 'expiry_unconfirmed',
    });
  },
);

it.skipIf(noDatabase)(
  'Trace retention: owed runs left unanswered together are paged past one by one, each read once',
  async () => {
    // Two runs asked, their deletes timing out, then each takes a fresh handback: two owed asks.
    const works = await agedRuns('trace retention unanswered turn', 2);
    const timeout: ExpiryPorts = {
      expire: () => Promise.resolve({ ok: false, fault: 'timeout', status: null }),
      present: t.target.expiry.present,
    };
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, timeout);
    for (const work of works) {
      // eslint-disable-next-line no-await-in-loop -- one handback after another
      const answer = await asAgent(
        t.alpha,
        handbackBody(work.picked),
        String(work.picked['credential']),
      );
      expect(codeOf(answer)).toBe('applied');
    }
    await drain(t.alpha);

    // One pass leaves every owed read unanswered: they share one recorded turn.
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, reading(() => true).ports);

    // Paged one run at a time past that turn, each owed run is read once and the pass ends.
    const traces: string[] = [];
    const ports: ExpiryPorts = {
      expire: (ids) => t.target.expiry.expire(ids),
      present: (traceId, spanId) => {
        traces.push(traceId);
        if (traces.length > 20) throw new Error('the owed pages do not end');
        return t.target.expiry.present(traceId, spanId);
      },
    };
    await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, ports, { page: 1 });
    expect(new Set(traces).size, 'no owed run read twice').toBe(traces.length);
  },
);
