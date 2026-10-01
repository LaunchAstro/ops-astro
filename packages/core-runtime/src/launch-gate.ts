// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b): the launch is the effect gate. Two facts the dispatch recheck
// adds to its own (`dispatch.ts`), and one the launch decision checks
// (`decide.ts`):
//
// - The approval behind the work is the launch of a reviewed output
//   (`isReviewedOutput`), never the plan accept, which lets the agent work and
//   releases nothing (`DECISION_STALE`).
// - Where the business requires the client's sign-off
//   (`client_sign_off_required`), agency approval alone never releases the
//   effect: the launch cannot decide and the dispatch recheck refuses
//   `CLIENT_SIGNOFF_REQUIRED`. The client's own sign-off is recorded in the
//   portal (MP-11-5, phase 8), which does not exist yet, so the task fails
//   closed here, visibly, with that code.
//
// The setting's row is held `for share` before the answer is read. The
// settings write takes it `for update` (`writeBusinessSetting`), so a change in
// flight is waited for and then seen, and one arriving later waits for this
// transaction. It sits outside the runtime's lock order, as the grant rows do:
// the settings write holds no runtime lock, so neither side can wait on the
// other in a cycle. A business with no row has the default, off.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from './refusals.ts';
import { isReviewedOutput } from './reviewed-output-standin.ts';

/** The business's `client_sign_off_required`, its row held for share to commit. */
export async function holdSignOffSetting(tx: TenantQuery): Promise<boolean> {
  const rows = await tx.query<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = 'client_sign_off_required'
        for share`,
    [tx.businessId],
  );
  return rows[0]?.value === true;
}

export function signOffRequired(): RuntimeResult<never> {
  return refuse(
    'CLIENT_SIGNOFF_REQUIRED',
    'this business requires the client’s sign-off before an effect goes out, and agency approval alone does not release it',
    'Nothing was sent. The client signs off in the client portal, which is not built yet, so this work stays held.',
  );
}

/**
 * The launch decision's own check, under the decision's locks: a reviewed
 * output is not launched while the business requires the client's sign-off.
 */
export async function launchDecisionRefusal(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  if (!(await isReviewedOutput(tx, versionId))) return null;
  return (await holdSignOffSetting(tx)) ? signOffRequired() : null;
}

/** The effect-time launch fact: the approval behind the lease launched a reviewed output. */
export async function launchRecheck(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  if (await isReviewedOutput(tx, versionId)) return null;
  return refuse(
    'DECISION_STALE',
    'the approval behind this lease accepted a plan, and only the launch of the reviewed output releases an effect',
    'Nothing was dispatched. Hand the output back for review; launching that reviewed version releases the effect.',
  );
}
