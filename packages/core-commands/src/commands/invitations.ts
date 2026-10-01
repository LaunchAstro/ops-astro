// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T invitations: not built yet.

import type { Database, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

export const INVITATION_LIFETIME_DAYS = 7;
export const INVITATION_LIMITS = { perAddressPerHour: 0, perAccountPerHour: 0 } as const;

type Act = CommandRequest & {
  readonly command: 'invitation.create' | 'invitation.resend' | 'invitation.revoke';
};

export async function invitationAct(
  _tx: TenantQuery,
  _context: CommandContext,
  _request: Act,
): Promise<HandlerOutcome> {
  return refused(refuseCommand('DEPENDENCY_NOT_LANDED', [], ['C39-T']));
}

export async function expireInvitations(
  _database: Database,
  _businessId: string,
): Promise<readonly string[]> {
  return [];
}
