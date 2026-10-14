// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's acts run as the operator's authorised act (#970): the web
// deploy's Vercel calls and record (web-deploy.ts, web-deploy.mjs), and the
// promotion's pointing, starting and record (promotion.ts, promote.mjs), each
// under the gate's held grant with the gate asked again first.

import type { Gate } from './operator.ts';

/**
 * `work`, run as the operator's authorised act: their grant held and the gate
 * asked again under the hold first (`authorisedAct`, below). Rejects,
 * with `work` never begun, when the gate no longer admits the same person.
 */
export type Authorised = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * `work` under `authorised`: what it answered, or what `authorised` refused
 * with before `work` began. A throw from inside `work` is its own, unchanged.
 */
export async function heldFor<T>(
  authorised: Authorised,
  work: () => T | Promise<T>,
): Promise<{ ran: T } | { refused: string }> {
  let began = false;
  try {
    return {
      ran: await authorised(async () => {
        began = true;
        return await work();
      }),
    };
  } catch (error) {
    if (began) throw error;
    return { refused: (error as Error).message };
  }
}

/**
 * `work` as the operator's authorised act (#970), the drill's `attested`
 * shape (drill-acts.mjs): the person's own `operations:manage` grant rows held
 * FOR SHARE (`holdingGrant`), and the gate asked again under that hold before
 * `work` begins (`stillOperator`: the sign-in verified again, the login
 * resolved again to the same person in the same business, the key held over
 * the whole of it). A revocation after the ask waits until `work` ends; one
 * before it, an ended or expired sign-in, or a login that now resolves to
 * another person rejects with `work` never begun. The hold locks only those
 * grant rows: a change it does not lock (a grant held through an acting
 * identity or a parent grant, the membership, a remap after the ask) is
 * ordered after the act. `work` writes the act's record before it ends, so
 * the record is written under the hold too.
 */
export async function authorisedAct<T>(
  gate: Extract<Gate, { ok: true }>,
  work: () => Promise<T>,
): Promise<T> {
  return await gate.holdingGrant(async (release) => {
    await gate.stillOperator();
    try {
      return await work();
    } finally {
      release();
    }
  });
}
