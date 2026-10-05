// SPDX-License-Identifier: AGPL-3.0-only
//
// P26 round 2, finding 4: the draft runner's cancel, on round 2's world
// (`live-correction-lows-2.ts` registers these blocks). The runner polls the
// correction's state for a cancel during a publish: one before the dispatch
// stops it, `CANCELLED`, nothing sent; one after the dispatch is an uncertain
// effect it records `unknown` (`core-connectors/src/site/publish.ts`). So an
// approved correction can be cancelled with its decision kept, and a cancelled
// one decided takes an unknown result with its receipt. Every other move to or
// from cancelled is refused, at the record layer and by a raw update.
//
// P26 round 3, finding 2: a cancel landing during the runner's read-back finds
// the publish already out. A decided cancelled correction takes any publish
// result, keeps its receipt with the observed outcome, and is recorded unknown;
// an undecided one takes none.

import { expect, it } from 'vitest';
import {
  recordObservedResult,
  type ObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { countOf, filed, inBusiness, lows, RECEIPTS, stateOf } from './live-correction-lows.ts';

type PublishOutcome = 'accepted' | 'live' | 'unknown' | 'failed';

/** An observed publish, as the runner writes it under the world's lease. */
export const observedPublish = (correctionId: string, outcome: PublishOutcome): ObservedResult => ({
  correctionId,
  leaseId: lows().leaseId,
  fence: lows().fence,
  actorId: lows().s.agentActorId,
  step: 'publish',
  outcome,
  observations: { seen: outcome },
});

const observed = async (correctionId: string, outcome: PublishOutcome) =>
  await inBusiness(
    async (tx) => await recordObservedResult(tx, observedPublish(correctionId, outcome)),
  );

const OUTCOME = 'select outcome from public.live_correction_receipts where correction_id = $1';

/** A raw update of one correction, as the application role. */
const update = async (id: string, set: string, parameters: readonly unknown[] = []) =>
  await inBusiness(
    async (tx) =>
      await tx.query(
        `update public.live_corrections set ${set} where business_id = $1 and id = $2`,
        [lows().s.business, id, ...parameters],
      ),
  );

const PINNED = /live_corrections_pinned: correction .* (keeps its decision|cannot move)/u;

/** A correction decided, then moved by raw updates (each allowed) into `state`. */
async function decidedIn(state: string): Promise<string> {
  const { id } = await filed(state === 'rejected' ? 'rejected' : 'approved');
  if (state === 'reverted') await update(id, `state = 'live'`);
  if (state !== 'approved' && state !== 'rejected') await update(id, 'state = $3', [state]);
  return id;
}

export function findingFourAllowed(): void {
  it('an approved correction cancelled before its dispatch keeps its decision', async () => {
    const id = await decidedIn('approved');
    await update(id, `state = 'cancelled', revision = revision + 1`);
    const [row] = await lows().s.db.admin.execute(
      'select state, decided_by_person_id as decider from public.live_corrections where id = $1',
      [id],
    );
    expect(row).toStrictEqual({ state: 'cancelled', decider: lows().s.decider.personId });
    const moved = update(id, 'decided_by_person_id = $3', [lows().other.personId]);
    await expect(moved).rejects.toThrow(PINNED);
  });

  it('a cancel landing after the dispatch is recorded unknown, with its receipt', async () => {
    const id = await decidedIn('cancelled');
    expect(await observed(id, 'unknown')).toMatchObject({ ok: true, state: 'unknown' });
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['unknown', 1]);
  });
}

export function findingFourRefused(): void {
  it('a cancelled correction takes no revert, and no raw move but to unknown', async () => {
    const id = await decidedIn('cancelled');
    const revert: ObservedResult = {
      ...observedPublish(id, 'unknown'),
      step: 'revert',
      outcome: 'reverted',
    };
    expect(await inBusiness(async (tx) => await recordObservedResult(tx, revert))).toStrictEqual({
      ok: false,
      code: 'GATE_NOT_APPROVED',
    });
    const moves = ['requested', 'approved', 'rejected', 'accepted', 'live', 'failed', 'reverted'];
    await Promise.all(
      moves.map(async (to) => await expect(update(id, 'state = $3', [to])).rejects.toThrow(PINNED)),
    );
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['cancelled', 0]);
  });

  it('a request cancelled before any decision never becomes unknown, a decider planted', async () => {
    const { id } = await filed();
    await update(id, `state = 'cancelled'`);
    const { actorId, personId } = lows().s.decider;
    const planted = `state = 'unknown', decided_by_actor_id = $3, decided_by_person_id = $4,
                     decided_at = now(), decided_version_digest = version_digest`;
    await expect(update(id, planted, [actorId, personId])).rejects.toThrow(PINNED);
    expect(await stateOf(id)).toBe('cancelled');
  });

  it('once decided, only an approved correction is cancelled', async () => {
    const froms = ['rejected', 'accepted', 'unknown', 'live', 'failed', 'reverted'];
    const ids = await Promise.all(froms.map(async (from) => await decidedIn(from)));
    await Promise.all(
      ids.map(
        async (id) => await expect(update(id, `state = 'cancelled'`)).rejects.toThrow(PINNED),
      ),
    );
    expect(await Promise.all(ids.map(async (id) => await stateOf(id)))).toStrictEqual(froms);
  });
}

/** P26 round 3, finding 2: a cancel committed between the dispatch and the receipt write. */
export function cancelDuringReadBack(): void {
  it('a decided cancelled correction keeps any publish result’s receipt, recorded unknown', async () => {
    const outcomes = ['accepted', 'live', 'failed'] as const;
    const cases = await Promise.all(
      outcomes.map(async (outcome) => ({ outcome, id: await decidedIn('cancelled') })),
    );
    const ids = cases.map((each) => each.id);
    const answers = await Promise.all(
      cases.map(async ({ id, outcome }) => await observed(id, outcome)),
    );
    expect(answers).toMatchObject(outcomes.map(() => ({ ok: true, state: 'unknown' })));
    const receipts = await Promise.all(
      ids.map(async (id) =>
        (await lows().s.db.admin.execute<{ readonly outcome: string }>(OUTCOME, [id])).map(
          (row) => row.outcome,
        ),
      ),
    );
    expect(receipts).toStrictEqual(outcomes.map((outcome) => [outcome]));
    const states = await Promise.all(ids.map(async (id) => await stateOf(id)));
    expect(states).toStrictEqual(['unknown', 'unknown', 'unknown']);
  });

  it('a request cancelled before any decision takes no publish result and writes nothing', async () => {
    const { id } = await filed();
    await update(id, `state = 'cancelled'`);
    const outcomes = ['accepted', 'live', 'unknown', 'failed'] as const;
    const answers = await Promise.all(outcomes.map(async (outcome) => await observed(id, outcome)));
    expect(answers).toStrictEqual(outcomes.map(() => ({ ok: false, code: 'GATE_NOT_APPROVED' })));
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['cancelled', 0]);
  });
}
