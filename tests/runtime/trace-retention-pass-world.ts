// SPDX-License-Identifier: AGPL-3.0-only
//
// Helpers for the read budget's cases over the AW-13 world: a due run, owed
// runs (asked, their delete timing out, then a fresh handback exported), the
// target's deletes and reads watched with each read's answer, and what the
// batches and the export cursor say of a run.

import type { ExpiryPorts, RetentionBatch } from '../../packages/core-runtime/src/index.ts';
import { derivedId, expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import type { Answer, PassBudget } from '../../packages/core-runtime/src/trace-store.ts';
import {
  asAgent,
  codeOf,
  handbackBody,
  liveWork,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { age } from './aw-13-retention-world.ts';
import { drain, t, TRACE_KEY } from './aw-13-world.ts';

export const traceOf = (s: Schedules, runId: string): string =>
  derivedId(TRACE_KEY, ['trace', s.business, runId], 32);

export const spanOf = (s: Schedules, eventId: string): string =>
  derivedId(TRACE_KEY, ['span', s.business, eventId], 16);

/** One retention pass for the business, as the deployment's pass would run it. */
export async function pass(
  s: Schedules,
  ports: ExpiryPorts,
  options: { readonly page?: number; readonly budget?: PassBudget } = {},
): Promise<readonly RetentionBatch[]> {
  return await expireOnce(t.alpha.db.app, s.business, TRACE_KEY, ports, options);
}

/** Runs exported whole and aged past the window: due, in run id order. */
export async function dueRuns(s: Schedules, label: string, count: number): Promise<string[]> {
  const runs: string[] = [];
  for (let n = 0; n < count; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    runs.push(String((await liveWork(s, `${label} ${String(n)}`, 1_000)).picked['runId']));
  }
  await drain(s);
  for (const runId of runs) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    await age(runId, TRACE_WINDOW_DAYS + 1);
  }
  return runs.toSorted();
}

/**
 * Owed runs, in run id order: each asked, its delete timing out, then a fresh
 * handback exported, so each has one sent span since its place.
 */
export async function owedRuns(s: Schedules, label: string, count: number): Promise<string[]> {
  const works = [];
  for (let n = 0; n < count; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    works.push(await liveWork(s, `${label} ${String(n)}`, 1_000));
  }
  await drain(s);
  for (const work of works) {
    // eslint-disable-next-line no-await-in-loop -- one run after another
    await age(String(work.picked['runId']), TRACE_WINDOW_DAYS + 1);
  }
  const timeout: ExpiryPorts = {
    expire: () => Promise.resolve({ ok: false, fault: 'timeout', status: null }),
    present: t.target.expiry.present,
  };
  const asked = await pass(s, timeout);
  if (asked.at(-1)?.code !== 'target_timeout') throw new Error('no delete timed out');
  for (const work of works) {
    // eslint-disable-next-line no-await-in-loop -- one handback after another
    const answer = await asAgent(s, handbackBody(work.picked), String(work.picked['credential']));
    if (codeOf(answer) !== 'applied') throw new Error('the handback was not applied');
  }
  await drain(s);
  return works.map((work) => String(work.picked['runId'])).toSorted();
}

/** The latest event of the run, by the export's order. */
export async function lastEvent(s: Schedules, runId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    s,
    `select id from public.run_events where business_id = $1 and run_id = $2
      order by tx desc, id desc limit 1`,
    [s.business, runId],
  );
  if (row === undefined) throw new Error('the run has no event');
  return row.id;
}

export interface Seen {
  readonly op: 'DELETE' | 'GET';
  readonly trace: string;
  readonly span?: string | undefined;
  readonly answer?: Answer | undefined;
}

/**
 * The target's ports with every delete and read seen, in order, each read
 * with its answer; `answer` stands in for the target on the reads it names.
 */
export function watched(answer?: (trace: string, span: string | undefined) => Answer | undefined): {
  readonly ports: ExpiryPorts;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    ports: {
      expire: async (traceIds) => {
        for (const trace of traceIds) seen.push({ op: 'DELETE', trace });
        return await t.target.expiry.expire(traceIds);
      },
      present: async (trace, span) => {
        const given = answer?.(trace, span) ?? (await t.target.expiry.present(trace, span));
        seen.push({ op: 'GET', trace, span, answer: given });
        return given;
      },
    },
  };
}

/** Whether a batch has confirmed the run expired. */
export async function confirmed(s: Schedules, runId: string): Promise<boolean> {
  const [row] = await rows<{ n: number }>(
    s,
    `select count(*)::int as n from public.trace_expiry_batches
      where business_id = $1 and expired_run_ids @> array[$2::uuid]`,
    [s.business, runId],
  );
  return (row?.n ?? 0) > 0;
}

/** The export cursor's place. */
export async function cursorOf(s: Schedules): Promise<string> {
  const [row] = await rows<{ place: string }>(
    s,
    `select after_tx::text || '/' || after_id::text as place
       from public.trace_export_cursors where business_id = $1`,
    [s.business],
  );
  return row?.place ?? '';
}
