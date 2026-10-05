// SPDX-License-Identifier: AGPL-3.0-only
//
// A new version of a lineage may ask only for the room superseding its predecessor gives back,
// and that is what the classifier releases, not the predecessor's whole hold (#836). A hold
// closes at its settled model calls' spend, so that spend stays committed; a call sent and never
// settled keeps the whole hold. Before this, preflight subtracted every held_minor, promised room
// that did not exist, and wrote a gate whose approval was refused BUDGET_UNAVAILABLE.
//
// The pin that preflight's prediction is the classifier's release is
// `superseding-predicts-the-classifier.test.ts`.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asPerson,
  codeOf,
  freshPurpose,
  liveWork,
  proposeBody,
  revisionOf,
  rows,
  type Work,
} from './schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('supersede');

/** The replay call's priced maximum (`REPLAY_COMPOSE`): a hold of this size takes one call. */
const CEILING = 500;

const withCall = async (mode: 'answer' | 'cut' | 'none'): Promise<Work> => {
  const work = await liveWork(s, `supersede ${mode} ${randomUUID()}`, CEILING);
  if (mode === 'none') return work;
  world.provider.mode(mode);
  await call(work);
  world.provider.mode('answer');
  return work;
};

const revise = async (work: Work): ReturnType<typeof asPerson> =>
  await asPerson(s, {
    ...proposeBody(work.taskId, await revisionOf(s, work.taskId), {
      lineageId: String(work.proposal['lineageId']),
      maximumMinor: CEILING,
      purpose: freshPurpose(),
    }),
  });

interface Standing {
  readonly reservation: string;
  readonly lineage: string;
  readonly live_versions: string;
  readonly committed: string;
}

const standing = async (work: Work): Promise<Standing | undefined> =>
  (
    await rows<Standing>(
      s,
      `select r.state as reservation, l.state as lineage,
              (select count(*) from public.proposal_versions v
                where v.business_id = l.business_id and v.lineage_id = l.id
                  and v.superseded_at is null)::text as live_versions,
              (e.held_minor + e.actual_minor)::text as committed
         from public.reservations r
         join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
         join public.proposal_lineages l on l.business_id = r.business_id and l.id = $3
        where r.business_id = $1 and r.id = $2`,
      [s.business, work.decision['reservationId'], work.proposal['lineageId']],
    )
  )[0];

for (const mode of ['answer', 'cut'] as const) {
  it(`a replacement ceiling is refused when the predecessor's ${mode === 'answer' ? 'settled' : 'unresolved'} call keeps its room`, async () => {
    const work = await withCall(mode);
    const before = await standing(work);

    const revised = await revise(work);

    expect(codeOf(revised)).toBe('PROPOSAL_SCOPE_EXCEEDED');
    expect(await standing(work)).toStrictEqual(before);
  });
}

it('with no call on the predecessor, the same replacement ceiling fits the room it gives back', async () => {
  const work = await withCall('none');

  appliedDetail(await revise(work), 'task.propose');
});
