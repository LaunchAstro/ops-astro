// SPDX-License-Identifier: AGPL-3.0-only
//
// Core's standing mandate check (MP-14-10a, CS-14.19; owner answer 13).
//
// Asked at the effect, inside the transaction that applies it: does a live
// standing mandate pre-approve this action class, for this client, at this
// value? It share-locks the client's row, the class's graduation row and the
// client's not-revoked mandates (`lockMandateQuestion`), so a revocation or a
// refusal being filed either waits for this effect to commit (an effect past
// its gate is not undone) or has committed and this check sees it. Expiry is
// judged on the database's clock after that lock wait, never on a time the
// caller hands in.
//
// Class, client, ceiling, currency, expiry and revocation are all checked
// here, from the structured fields; the sentence is a label and is never read.
// A matching live refusal wins over any approval. An approval covers only a
// class on the client's own list whose record is not `never`. Anything not
// covered is the ordinary gate's to decide: this check only ever removes a
// question, it never answers one the other way. A malformed question is a
// caller's mistake and throws, before anything is read.

import {
  classMatches,
  isActionClass,
  isUuid,
  lockMandateQuestion,
  type TenantQuery,
} from '../../core-records/src/index.ts';

export interface MandateQuestion {
  readonly clientId: string;
  readonly actionClass: string;
  readonly valueMinor: number;
  readonly currency: string;
}

export type MandateVerdict =
  | { readonly covered: true; readonly mandateId: string }
  | {
      readonly covered: false;
      readonly reason: 'refused' | 'over-ceiling' | 'other-currency' | 'expired';
      readonly mandateId: string;
    }
  | { readonly covered: false; readonly reason: 'none' | 'not-graduable' };

const isCurrency = (text: string): boolean =>
  text.length === 3 && [...text].every((one) => one >= 'A' && one <= 'Z');

export async function standingMandateVerdict(
  tx: TenantQuery,
  question: MandateQuestion,
): Promise<MandateVerdict> {
  if (!Number.isSafeInteger(question.valueMinor) || question.valueMinor < 0) {
    throw new RangeError('standingMandateVerdict: the value is a whole number of minor units');
  }
  if (!isUuid(question.clientId) || !isActionClass(question.actionClass)) {
    throw new RangeError(
      'standingMandateVerdict: the client is an id and the class an action class',
    );
  }
  if (!isCurrency(question.currency)) {
    throw new RangeError('standingMandateVerdict: the currency is three capital letters');
  }
  const { earned, mandates } = await lockMandateQuestion(
    tx,
    question.clientId,
    question.actionClass,
  );
  const matching = mandates.filter((one) =>
    one.classes.some((scope) => classMatches(scope, question.actionClass)),
  );
  const live = matching.filter((one) => one.live);
  const refusal = live.find((one) => one.refuses);
  if (refusal !== undefined) return { covered: false, reason: 'refused', mandateId: refusal.id };
  const approvals = live.filter((one) => !one.refuses);
  if (approvals.length > 0 && (earned === null || earned === 'never')) {
    return { covered: false, reason: 'not-graduable' };
  }
  const sameCurrency = approvals.filter((one) => one.currency === question.currency);
  const within = sameCurrency.find(
    (one) => one.ceilingMinor !== null && question.valueMinor <= one.ceilingMinor,
  );
  if (within !== undefined) return { covered: true, mandateId: within.id };
  const over = sameCurrency[0];
  if (over !== undefined) return { covered: false, reason: 'over-ceiling', mandateId: over.id };
  const other = approvals[0];
  if (other !== undefined) {
    return { covered: false, reason: 'other-currency', mandateId: other.id };
  }
  const expired = matching.find((one) => !one.refuses);
  if (expired !== undefined) return { covered: false, reason: 'expired', mandateId: expired.id };
  return { covered: false, reason: 'none' };
}
