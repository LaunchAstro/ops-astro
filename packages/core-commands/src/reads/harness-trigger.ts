// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the harness trigger read on one run of the caller's
// business, under the caller's grant.
//
// The run's required reading is its accept-time manifest (AW-04): every
// instruction file the run may read, by path, digest and size, summed. A run
// with no pin reads nothing. A manifest entry with no whole size is refused,
// never counted as nothing, because an under-count could say "not yet" where
// the work does not fit. The run sub-delegates when its parent's holder has
// handed part of it to a helper (AW-11's `delegated` run event).
//
// It is the team's: a reader outside it, or one with no live `task:read`, is
// refused. The run is filtered by the caller's grant on its task inside the
// statement (the business, the task, or the task's client: the grants
// `taskAccess` asks), so a run outside it, in another business or not there
// at all, is one `NOT_FOUND` with nothing in it. Nothing here writes.

import { readScopes } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { readTrigger, type TriggerReading } from '../../../core-runtime/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface ShapeRow {
  readonly reading: string;
  readonly uncounted: string;
  readonly delegated: boolean;
}

// A manifest entry counts only with a whole, non-negative size; any other is
// `uncounted`. No pin is no row in the join: nothing to read.
const SHAPE = `select coalesce(sum(case when m.counted then (m.entry->>'size')::bigint end), 0)::text
              as reading,
            count(*) filter (where m.entry is not null and not m.counted)::text as uncounted,
            exists (select 1 from public.run_events e
                     where e.business_id = pr.business_id and e.run_id = pr.id
                       and e.kind = 'delegated') as delegated
       from public.planned_runs pr
       join public.records r on r.business_id = pr.business_id and r.id = pr.task_id
       left join public.run_definition_pins pin
         on pin.business_id = pr.business_id and pin.run_id = pr.id
       left join lateral (
         select entry,
                coalesce(jsonb_typeof(entry->'size') = 'number'
                         and (entry->>'size') ~ '^[0-9]{1,15}$', false) as counted
           from jsonb_array_elements(pin.manifest) as entry) m on true
      where pr.business_id = $1 and pr.id = $2 and r.deleted_at is null
        and ($3::boolean or r.id = any($4::uuid[]) or r.uuid_7 = any($5::uuid[]))
      group by pr.business_id, pr.id`;

const UNCOUNTED_FIXES = [
  'A file in the pinned manifest has no whole size, so the reading cannot be counted.',
  'Pin the run again from its plan; the trigger is read on a manifest it can count.',
];

export async function readHarnessTrigger(
  tx: TenantQuery,
  session: Session,
  runId: string,
): Promise<TriggerReading | CommandRefusal> {
  const scopes = await readScopes(tx, session.personId);
  const reaches = scopes.business || scopes.records.length > 0 || scopes.parties.length > 0;
  if (!isInternalReader(session.roleKey) || !reaches) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  if (!UUID.test(runId)) return refuseNotFound();
  const rows = await tx.query<ShapeRow>(SHAPE, [
    tx.businessId,
    runId,
    scopes.business,
    scopes.records,
    scopes.parties,
  ]);
  const row = rows[0];
  if (row === undefined) return refuseNotFound();
  const readingBytes = Number(row.reading);
  // A sum past an exact whole number is no more a figure than a missing size.
  if (Number(row.uncounted) > 0 || !Number.isSafeInteger(readingBytes)) {
    return refuseCommand('DEFINITION_UNAVAILABLE', [], UNCOUNTED_FIXES);
  }
  return readTrigger({ readingBytes, delegationDepth: row.delegated ? 1 : 0 });
}
