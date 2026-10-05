// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b): the launch is the effect gate. Two facts the dispatch recheck
// adds to its own (`dispatch.ts`), and one the launch decision checks
// (`decide.ts`):
//
// - The approval behind the work is the launch of a reviewed output
//   (`isReviewedOutput`, `reviewed-output.ts`), never the plan accept, which
//   lets the agent work and releases nothing (`LAUNCH_NOT_DECIDED`).
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
// transaction. A business with no row has the default, off, and a missing row
// locks nothing, so the settings install lock (`lockSettingsInstall`, the
// advisory key `<business id>:business_settings`) is held shared first: the
// install takes it exclusive before it adds the row, so the first row cannot
// commit between this check and the dispatch marker. Both sit outside the
// runtime's lock order, as the grant rows do: the settings install and write
// hold no runtime lock, so neither side can wait on the other in a cycle.

import { lockSettingsInstall, type TenantQuery } from '../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from './refusals.ts';
import { isReviewedOutput, launchNotDecided } from './reviewed-output.ts';

/**
 * The business's `client_sign_off_required`, held to commit: the install lock
 * shared, then the row for share.
 */
export async function holdSignOffSetting(tx: TenantQuery): Promise<boolean> {
  await lockSettingsInstall(tx, 'shared');
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
  // The setting first: with it off nothing else is read.
  if (!(await holdSignOffSetting(tx))) return null;
  return (await isReviewedOutput(tx, versionId)) ? signOffRequired() : null;
}

/** The effect-time launch fact: the approval behind the lease launched a reviewed output. */
export async function launchRecheck(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  return (await isReviewedOutput(tx, versionId)) ? null : launchNotDecided();
}
