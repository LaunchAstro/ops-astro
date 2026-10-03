// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-09: the agent's output takes its own round of review, and a person completes
// it, never the agent that produced it.
//
// The surfaces already keep the agent out: its delegation never reaches
// `decide` (`DELEGATION_EXCLUDES_DECISION`), and the person prefix resolves
// only a person's login. But `decide` is handed the deciding actor by its
// caller and the schema checks only that the actor exists, so a caller that
// passed the agent's actor beside a person's grants would have the agent
// complete its own round. The runtime therefore asks the deciding actor itself,
// on every decision it guards, whatever the version: the active person actor
// of the person deciding. Anything else is the agent's refusal, in the
// delegation check's code, because that is what it is.
//
// Asked under the decision's locks, after the grant is re-read, before
// anything is written; an escalation is asked the same.

import { refuseCommand } from '../../core-records/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { RuntimeResult } from './refusals.ts';

export interface Reviewer {
  readonly decidedByPersonId: string;
  readonly decidedByActorId: string;
}

const PASSED: RuntimeResult<null> = { ok: true, value: null };

/** The decider is a person acting as themselves, or this refuses. */
export async function reviewedByPerson(
  tx: TenantQuery,
  reviewer: Reviewer,
): Promise<RuntimeResult<null>> {
  const acting = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and id = $2 and kind = 'person' and person_id = $3 and active`,
    [tx.businessId, reviewer.decidedByActorId, reviewer.decidedByPersonId],
  );
  if (acting.length === 1) return PASSED;
  return {
    ok: false,
    refusal: refuseCommand(
      'DELEGATION_EXCLUDES_DECISION',
      [],
      [
        "a decision on this task is made by a person acting as themselves, never by an agent's actor",
        'The person who holds decide on this task decides it under their own login.',
      ],
    ),
  };
}
