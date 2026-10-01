// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T invitation send: not built yet.

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { MailSettings } from './broker-email.ts';
import type { Broker } from './broker-types.ts';

export type InvitationSendResult =
  | { readonly ok: true; readonly attemptId: string; readonly state: 'accepted' }
  | { readonly ok: false; readonly code: string };

export async function sendInvitation(
  _database: Database,
  _businessId: BusinessId,
  _invitationId: string,
  _broker: Broker,
  _mail: MailSettings,
): Promise<InvitationSendResult> {
  return { ok: false, code: 'OPERATION_NOT_CATALOGUED' };
}
