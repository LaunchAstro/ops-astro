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
//   effect on a task with a client: the launch cannot decide and the dispatch
//   recheck refuses `CLIENT_SIGNOFF_REQUIRED`. The client's own sign-off is
//   recorded in the portal (MP-11-5, phase 8), which does not exist yet, so
//   such a task fails closed here, visibly, with that code. A task with no
//   client has no client to sign off, and agency approval releases it.
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
async function holdSignOffSetting(tx: TenantQuery): Promise<boolean> {
  await lockSettingsInstall(tx, 'shared');
  const rows = await tx.query<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = 'client_sign_off_required'
        for share`,
    [tx.businessId],
  );
  return rows[0]?.value === true;
}

/**
 * Whether the task `versionId` proposes work on has a client. `task.set_party`
 * refuses a task with work, and a proposed version is work, so the link cannot
 * change under this check.
 */
async function forClient(tx: TenantQuery, versionId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly client: boolean }>(
    `select t.data ->> 'client' is not null as client
       from public.proposal_versions v
       join public.proposal_lineages l on l.business_id = v.business_id and l.id = v.lineage_id
       join public.records t on t.business_id = l.business_id and t.id = l.task_id
      where v.business_id = $1 and v.id = $2`,
    [tx.businessId, versionId],
  );
  return rows[0]?.client === true;
}

function signOffRequired(): RuntimeResult<never> {
  return refuse(
    'CLIENT_SIGNOFF_REQUIRED',
    'this business requires the client’s sign-off before an effect goes out, and agency approval alone does not release it',
    'Nothing was sent. The client signs off in the client portal, which is not built yet, so this work stays held.',
  );
}

/**
 * The effect-time sign-off fact: nothing is released on a task with a client
 * while the business requires the client's sign-off.
 */
export async function signOffRefusal(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  // The setting first: with it off nothing else is read.
  if (!(await holdSignOffSetting(tx))) return null;
  return (await forClient(tx, versionId)) ? signOffRequired() : null;
}

/**
 * The launch decision's own check, under the decision's locks: a reviewed
 * output on a task with a client is not launched while the business requires
 * the client's sign-off.
 */
export async function launchDecisionRefusal(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  // The setting first: with it off nothing else is read.
  if (!(await holdSignOffSetting(tx))) return null;
  if (!(await isReviewedOutput(tx, versionId))) return null;
  return (await forClient(tx, versionId)) ? signOffRequired() : null;
}

/** The effect-time launch fact: the approval behind the lease launched a reviewed output. */
export async function launchRecheck(
  tx: TenantQuery,
  versionId: string,
): Promise<RuntimeResult<never> | null> {
  return (await isReviewedOutput(tx, versionId)) ? null : launchNotDecided();
}
