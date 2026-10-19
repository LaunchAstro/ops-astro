// SPDX-License-Identifier: AGPL-3.0-only
//
// The AW-12 A8 read (`aw-12-authorities.test.ts`), on AW-10's broker world:
// the run, its steps and its events as text.

import { s } from '../broker/aw-10-world.ts';
import { rows } from '../runtime/schedules-harness.ts';

/** The run, its steps and its events, as text. */
export const runRecord = async (runId: unknown): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select t::text from public.planned_runs t where business_id = $1 and id = $2) as run,
            (select string_agg(t::text, ',' order by t.id) from public.planned_steps t
              where business_id = $1 and run_id = $2) as steps,
            (select string_agg(t::text, ',' order by t.position) from public.run_events t
              where business_id = $1 and run_id = $2) as events`,
    [s.business, runId],
  );
