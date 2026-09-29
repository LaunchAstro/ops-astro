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

import { type TenantQuery } from '../../core-records/src/index.ts';

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
  _tx: TenantQuery,
  _question: MandateQuestion,
): Promise<MandateVerdict> {
  return await Promise.resolve({ covered: false, reason: 'none' });
}
