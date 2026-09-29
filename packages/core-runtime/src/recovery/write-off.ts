// SPDX-License-Identifier: AGPL-3.0-only
//
// T3c: the write-off (`budget.write_off`). A liability that never resolves is
// written off by a person holding budget permission (`billing:decide`), who
// gives the amount to charge (the reserved maximum, a lesser figure the
// evidence shows, or nothing) and a written reason. Never a timer: the one
// caller is the command a person sends (15.3, O6).
//
// It closes the one hold it names, under the step's locks, the same set a
// recorded outcome takes (`outcome.ts`), so the two race to one winner. It
// writes no row of its own among the money tables: no new attempt, hold or
// envelope (split 2.2, "no ledger row"). It moves no work: a step proved
// absent has already resumed on its own hold, and a step not proved absent
// keeps its stop until a person records an outcome for the work.
//
// Above the four-eyes band, T2e's stored setting read here, a second person
// names the same figure, exactly as a top-up pairs (`budget.ts`). The band is
// measured against the hold being closed, the money at stake, which is never
// less than the amount charged.

import {
  readBusinessSetting,
  refuseCommand,
  type CommandRefusal,
  type RefusalCode,
  type Subject,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { raiseAlert } from '../alerts.ts';
import { lockedInstant } from '../clock.ts';
import { lockRediscovered } from '../rediscovery.ts';
import { checkAuthorityAt, holdCoveringGrants } from './classifier.ts';
import { locksOf, UNKNOWN_SELECT, type Unknown } from './reconcile.ts';

export interface WriteOffRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly amountMinor: bigint;
  readonly reason: string;
  readonly personId: string;
  readonly subjects: readonly Subject[];
  readonly collection: string;
}

export type WrittenOff = Readonly<Record<string, unknown>> & {
  readonly state: 'applied' | 'awaiting_second_approver';
};

type WriteOffResult =
  | { readonly ok: true; readonly value: WrittenOff }
  | { readonly ok: false; readonly refusal: CommandRefusal };

const refused = (code: RefusalCode, reason: string, fix: string): WriteOffResult => ({
  ok: false,
  refusal: refuseCommand(code, [], [reason, fix]),
});

/** First approvals waiting on exactly this attempt and amount. */
const FIRST_APPROVALS = `
  select o.result -> 'detail' ->> 'firstApproverPersonId' as person_id, o.actor_id
    from public.operations o
   where o.business_id = $1 and o.command = 'budget.write_off' and o.outcome = 'applied'
     and o.result -> 'detail' ->> 'state' = 'awaiting_second_approver'
     and o.result -> 'detail' ->> 'attemptId' = $2
     and o.result -> 'detail' ->> 'amountMinor' = $3
   order by o.created_at`;

async function firstApprovers(
  tx: TenantQuery,
  attemptId: string,
  amountMinor: bigint,
): Promise<readonly { readonly personId: string; readonly subjects: readonly Subject[] }[]> {
  const rows = await tx.query<{ readonly person_id: string; readonly actor_id: string }>(
    FIRST_APPROVALS,
    [tx.businessId, attemptId, amountMinor.toString()],
  );
  return rows.map((row) => ({
    personId: row.person_id,
    subjects: [
      { kind: 'person', id: row.person_id },
      { kind: 'actor', id: row.actor_id },
    ],
  }));
}

/**
 * Close the hold at the amount: a positive figure settles it (the attempt's
 * outcome stays `unknown`, since nobody observed the effect), nothing
 * abandons it under the write-off. Either way the envelope gives the whole
 * hold back and takes the amount.
 */
async function close(tx: TenantQuery, row: Unknown, amount: bigint): Promise<void> {
  const [business, held] = [tx.businessId, row.held_minor];
  if (amount > 0n) {
    await tx.query(
      `update public.attempts
          set state = 'settled', actual_minor = $3, outcome = 'unknown', settled_at = now()
        where business_id = $1 and id = $2`,
      [business, row.attempt_id, amount.toString()],
    );
    await tx.query(
      `update public.reservations set state = 'actual', actual_minor = $3, terminal_at = now()
        where business_id = $1 and id = $2`,
      [business, row.reservation_id, amount.toString()],
    );
  } else {
    await tx.query(
      `update public.attempts set state = 'abandoned', outcome = 'abandoned'
        where business_id = $1 and id = $2`,
      [business, row.attempt_id],
    );
    await tx.query(
      `update public.reservations
          set state = 'abandoned', classified_cause = 'written_off',
              classified_cause_id = $3, terminal_at = now()
        where business_id = $1 and id = $2`,
      [business, row.reservation_id, row.attempt_id],
    );
  }
  await tx.query(
    `update public.task_envelopes
        set held_minor = held_minor - $3, actual_minor = actual_minor + $4
      where business_id = $1 and id = $2`,
    [business, row.envelope_id, held, amount.toString()],
  );
  if (amount > 0n) {
    await raiseAlert(tx, {
      taskId: row.task_id,
      causeId: row.attempt_id,
      raised: { kind: 'settled' },
    });
  }
}

type Holds = (subjects: readonly Subject[]) => Promise<boolean>;
type Approver = Awaited<ReturnType<typeof firstApprovers>>[number];

/**
 * Above the band, the first approver this write-off pairs with: a different
 * person naming the same figure whose grant is live at the locked instant.
 * `undefined` asks for a pair and has none; `null` needs none.
 */
async function pairFor(
  tx: TenantQuery,
  held: bigint,
  request: WriteOffRequest,
  of: { readonly firsts: readonly Approver[]; readonly holds: Holds },
): Promise<Approver | null | undefined | 'own'> {
  // Null is the band switched off; a business with no row has the shipped 500.
  const setting = await readBusinessSetting(tx, 'four_eyes_threshold');
  const band = setting === undefined ? 500 : setting.value;
  if (typeof band !== 'number' || held <= BigInt(Math.round(band * 100))) return null;
  const others = of.firsts.filter((first) => first.personId !== request.personId);
  const live = await Promise.all(others.map(async (one) => (await of.holds(one.subjects)) && one));
  const pair = live.find((one) => one !== false);
  if (pair === undefined && of.firsts.length > others.length) return 'own';
  return pair;
}

/**
 * A person's write-off, under the step's locks with their covering grants and
 * any first approver's held, and `billing:decide` on the task judged again at
 * the locked instant, for the caller and for the first approver it pairs with.
 */
export async function writeOff(tx: TenantQuery, request: WriteOffRequest): Promise<WriteOffResult> {
  const firsts = await firstApprovers(tx, request.attemptId, request.amountMinor);
  const subjects = [...request.subjects, ...firsts.flatMap((first) => first.subjects)];
  await holdCoveringGrants(tx, subjects, request.collection);
  const { found } = await lockRediscovered(tx, {
    discover: async () =>
      await tx.query<Unknown>(
        `${UNKNOWN_SELECT} where att.business_id = $1 and att.id = $2 and run.task_id = $3`,
        [tx.businessId, request.attemptId, request.taskId],
      ),
    locks: locksOf,
    rule: 'exact',
    changed: 'write-off: the step changed under discovery; roll back and write it off again',
  });
  const at = await lockedInstant(tx);
  const scope = { kind: 'record', id: request.taskId } as const;
  const ask = { collection: request.collection, action: 'decide', scope } as const;
  const holds: Holds = async (who) => (await checkAuthorityAt(tx, who, ask, at)).ok;
  if (!(await holds(request.subjects))) {
    return refused(
      'SCOPE_NOT_GRANTED',
      'no live grant to decide money on this task covers the write-off',
      'A person holding budget permission on this task writes it off.',
    );
  }
  const row = found[0];
  if (row?.attempt_state !== 'liability_unknown' || row.reservation_state !== 'held') {
    return refused(
      'LIABILITY_NOT_UNKNOWN',
      'this attempt is not held as an unknown liability',
      'Nothing was written off. Read the task: its money is already settled or never was unknown.',
    );
  }
  const held = BigInt(row.held_minor);
  if (request.amountMinor > held) {
    return refused(
      'FIELD_VALUE_INVALID',
      'a write-off charges no more than the hold',
      `Charge the reserved maximum (${row.held_minor}), a lesser figure the evidence shows, or 0.`,
    );
  }
  const pair = await pairFor(tx, held, request, { firsts, holds });
  if (pair === 'own') {
    return refused('FOUR_EYES_REQUIRED', 'you gave the first approval', 'Another holder approves.');
  }
  const figure = {
    attemptId: row.attempt_id,
    amountMinor: Number(request.amountMinor),
    reason: request.reason,
  };
  if (pair === undefined) {
    const state = 'awaiting_second_approver';
    return { ok: true, value: { ...figure, state, firstApproverPersonId: request.personId } };
  }
  await close(tx, row, request.amountMinor);
  const approvers = [...(pair === null ? [] : [pair.personId]), request.personId];
  return { ok: true, value: { ...figure, heldMinor: Number(held), state: 'applied', approvers } };
}
