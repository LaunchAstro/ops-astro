// SPDX-License-Identifier: AGPL-3.0-only
//
// Core's standing mandate check (MP-14-10a, CS-14.19; owner answer 13).
//
// Asked at the effect, inside the transaction that applies it: does a live
// standing mandate pre-approve this action class, for this client, at this
// value? It reads the client's not-revoked mandates under a share lock, so a
// revocation either waits for this effect to commit (an effect past its gate
// is not undone) or has committed and this check no longer sees the mandate.
//
// Class, client, ceiling, currency, expiry and revocation are all checked
// here, from the structured fields; the sentence is a label and is never read.
// A matching live refusal wins over any approval. Anything not covered is the
// ordinary gate's to decide: this check only ever removes a question, it never
// answers one the other way.

import {
  classMatches,
  mandateIsLive,
  lockClientMandates,
  type TenantQuery,
} from '../../core-records/src/index.ts';

export interface MandateQuestion {
  readonly clientId: string;
  readonly actionClass: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly at: Date;
}

export type MandateVerdict =
  | { readonly covered: true; readonly mandateId: string }
  | {
      readonly covered: false;
      readonly reason: 'refused' | 'over-ceiling' | 'expired';
      readonly mandateId: string;
    }
  | { readonly covered: false; readonly reason: 'none' };

export async function standingMandateVerdict(
  tx: TenantQuery,
  question: MandateQuestion,
): Promise<MandateVerdict> {
  if (!Number.isSafeInteger(question.valueMinor) || question.valueMinor < 0) {
    throw new RangeError('standingMandateVerdict: the value is a whole number of minor units');
  }
  const matching = (await lockClientMandates(tx, question.clientId)).filter((one) =>
    one.classes.some((scope) => classMatches(scope, question.actionClass)),
  );
  const live = matching.filter((one) => mandateIsLive(one, question.at));
  const refusal = live.find((one) => one.refuses);
  if (refusal !== undefined) return { covered: false, reason: 'refused', mandateId: refusal.id };
  const approvals = live.filter((one) => !one.refuses);
  const within = approvals.find(
    (one) =>
      one.currency === question.currency &&
      one.ceilingMinor !== null &&
      question.valueMinor <= one.ceilingMinor,
  );
  if (within !== undefined) return { covered: true, mandateId: within.id };
  const over = approvals[0];
  if (over !== undefined) return { covered: false, reason: 'over-ceiling', mandateId: over.id };
  const expired = matching.find((one) => !one.refuses);
  if (expired !== undefined) return { covered: false, reason: 'expired', mandateId: expired.id };
  return { covered: false, reason: 'none' };
}
