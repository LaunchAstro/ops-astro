// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's approver setting, `settings.set_live_correction_approver`, split out of
// `handlers.ts` so that file stays under the per-file size cap.

import { isActiveMember, isUuid } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import { setBusinessSetting } from './settings-write.ts';
import { endedRefusal, writerStillHolds } from './live-correction-standing.ts';

const APPROVER_FIXES: readonly string[] = [
  'Send value as the person id of an active member of this business, or null.',
];

/**
 * C80: a named member or nobody. Checked here, in the writing transaction, so
 * a person id from another business or a departed member is refused rather
 * than stored as an approver no approval could ever match. The id is stored in
 * its canonical lower case, and the writer's settings:manage is read again
 * after the setting's lock wait: one revoked meanwhile keeps nothing.
 */
export async function setApprover(
  tx: TenantQuery,
  context: CommandContext,
  request: CommandRequest & { readonly command: 'settings.set_live_correction_approver' },
): Promise<HandlerOutcome> {
  const { value } = request;
  if (value !== null && !(isUuid(value) && (await isActiveMember(tx, value)))) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], APPROVER_FIXES));
  }
  const written = await setBusinessSetting(
    tx,
    context,
    request.command,
    value === null ? null : value.toLowerCase(),
    request.expectedRevision,
  );
  if (isRefused(written)) return written;
  const stood = await writerStillHolds(tx, context);
  return stood === 'stands' ? written : refused(endedRefusal(stood, false));
}
