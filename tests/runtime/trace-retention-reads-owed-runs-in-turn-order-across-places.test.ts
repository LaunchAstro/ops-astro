// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention (#475): owed runs are read in turn order, whatever place
// their asks hold. A run that answers, asked at one place with three runs that
// never answer, must not keep a run asked at a later place from being read:
// the unanswered three go behind it from the next pass.

import { expect, it } from 'vitest';
import type { ExpiryPorts } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork, rows } from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

useAw13World('trret_turn_across_places');

const traceOf = (runId: string): string =>
  derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);

type Work = Awaited<ReturnType<typeof liveWork>>;

/** A fresh handback for each run, exported. */
async function handBack(works: readonly Work[]): Promise<void> {
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
}

it.skipIf(noDatabase)(
  'Trace retention: an answering run at one place with three unanswered ones does not hide a later place',
  async () => {
    const works: Work[] = [];
    for (let n = 0; n < 5; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- one run after another
      works.push(await liveWork(t.alpha, `trace retention turn order ${String(n)}`, 1000));
    }
    await drain(t.alpha);
    works.sort((x, y) => String(x.picked['runId']).localeCompare(String(y.picked['runId'])));
    const runOf = (work: Work): string => String(work.picked['runId']);
    // A sorts first, D last; U1 to U3 between them.
    const [a, u1, u2, u3, d] = works;
    if (a === undefined || u1 === undefined || u2 === undefined || u3 === undefined) {
      throw new Error('five runs expected');
    }
    if (d === undefined) throw new Error('five runs expected');

    // A and U1-U3 expire together at one place, then take fresh handbacks: owed at that place.
    for (const work of [a, u1, u2, u3]) {
      // eslint-disable-next-line no-await-in-loop -- one run after another
      await age(runOf(work), TRACE_WINDOW_DAYS + 1);
    }
    const first = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, t.target.expiry);
    expect(first.at(-1)).toMatchObject({ runs: 4, confirmed: 4, code: null });
    await handBack([a, u1, u2, u3]);

    // D is asked at the later place; its delete is queued and the caller times out.
    await age(runOf(d), TRACE_WINDOW_DAYS + 1);
    let queued: readonly string[] = [];
    const timeout: ExpiryPorts = {
      expire: (ids) => {
        queued = ids;
        return Promise.resolve({ ok: false, fault: 'timeout', status: null });
      },
      present: t.target.expiry.present,
    };
    const asked = await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, timeout);
    expect(asked.at(-1)).toMatchObject({ runs: 1, code: 'target_timeout' });
    expect(queued).toEqual([traceOf(runOf(d))]);
    const places = await rows<{ runId: string; place: string }>(
      t.alpha,
      `select distinct on (run_id) run_id as "runId", after_tx::text || '/' || after_id::text as place
         from public.trace_expiry_asks where business_id = $1
        order by run_id, after_tx desc, after_id desc`,
      [t.alpha.business],
    );
    const placeOf = (work: Work): string | undefined =>
      places.find((row) => row.runId === runOf(work))?.place;
    expect(placeOf(a), 'A and U1 share a place').toBe(placeOf(u1));
    expect(placeOf(d), 'D is asked at a later place').not.toBe(placeOf(a));

    // D's fresh handback goes out, then its queued delete lands.
    await handBack([d]);
    const [fresh] = await rows<{ id: string }>(
      t.alpha,
      `select id from public.run_events
        where business_id = $1 and run_id = $2 and kind = 'handed_back'`,
      [t.alpha.business, runOf(d)],
    );
    const freshSpan = derivedId(TRACE_KEY, ['span', t.alpha.business, String(fresh?.id)], 16);
    expect((await t.target.expiry.expire(queued)).ok).toBe(true);
    expect(t.target.stored.has(traceOf(runOf(d)))).toBe(false);

    // U1-U3 never answer; A and D read through to the target.
    const unreadable = new Set([u1, u2, u3].map((work) => traceOf(runOf(work))));
    const requested: string[] = [];
    const ports: ExpiryPorts = {
      expire: (ids) => t.target.expiry.expire(ids),
      present: (traceId, spanId) => {
        requested.push(traceId);
        return unreadable.has(traceId)
          ? Promise.resolve('unknown' as const)
          : t.target.expiry.present(traceId, spanId);
      },
    };
    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await expireOnce(t.alpha.db.app, t.alpha.business, TRACE_KEY, ports);
      // eslint-disable-next-line no-await-in-loop -- retention, then export, in turn
      await drain(t.alpha);
    }

    expect(requested, 'a pass reaches D').toContain(traceOf(runOf(d)));
    expect(
      t.target.spans.get(traceOf(runOf(d)))?.has(freshSpan) === true,
      "D's fresh handback is restored",
    ).toBe(true);
  },
);
