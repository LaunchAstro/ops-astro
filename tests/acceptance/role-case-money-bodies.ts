// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for the admin's money decisions, moved whole
// from role-case-bodies.ts to keep that file under the line limit: same bodies,
// same order.

import {
  PROPOSAL,
  type BodyContext,
  approvedTaskId,
  ownUnknownAttempt,
} from './role-case-bodies.ts';

/** The admin's money decisions: the admin holds `billing:decide` business-wide. */
export async function moneyBody(
  context: BodyContext,
  name: 'budget.top_up' | 'budget.record_outcome' | 'budget.write_off' | 'budget.set_planning_cap',
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'budget.top_up':
      // The admin approved the plan, so a top-up under the band is hers alone (T2e).
      return {
        recordId: await approvedTaskId(context),
        amountMinor: 100,
        fromMaximumMinor: PROPOSAL.maximumMinor,
      };
    case 'budget.record_outcome':
      // Any unknown attempt on the business's tasks is hers to record (O8, T3d1).
      return { ...(await ownUnknownAttempt(context)), outcome: 'happened' };
    case 'budget.write_off':
      // The same unknown hold, closed at nothing with a reason (T3c).
      return {
        ...(await ownUnknownAttempt(context)),
        amountMinor: 0,
        reason: 'The matrix writes its own unknown hold off.',
      };
    case 'budget.set_planning_cap': {
      // AW-04 (U10): one above where the cap is. A probe naming no limit
      // seen is refused naming the one it is at (the default, AUD 50, until
      // a person moves it).
      const cap = { limitMinor: 1_000, currency: 'AUD' };
      const probe = await context.asPerson(name, { ...cap, fromLimitMinor: null });
      const named = /^limitMinor=(\d+)$/u.exec(String((probe.body['names'] as unknown[])?.[0]));
      const at = probe.code === 'ok' ? cap.limitMinor : Number(named?.[1]);
      return { ...cap, limitMinor: at + 1, fromLimitMinor: at };
    }
  }
}
