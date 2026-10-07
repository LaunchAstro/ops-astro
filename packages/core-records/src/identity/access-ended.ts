// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal a login with no standing here gets, split out of login resolution to keep it small.

import type { TenantQuery } from '../tenancy/database.ts';
import { refuseCommand, type CommandRefusal } from '../register.ts';
import type { IdentityRefusalCode } from './refusals.ts';

export type Refusal = CommandRefusal<IdentityRefusalCode>;

/** Identity names nothing: which of several reasons applied is itself an inference. */
export const refuse = (code: IdentityRefusalCode, fixes: readonly string[]): Refusal =>
  refuseCommand(code, [], fixes);

export const NO_MEMBERSHIP_FIXES = [
  'ask an administrator of this business to link this login to a person',
  'check that the business named in the request is the intended one',
] as const;

const ACCESS_ENDED_FIXES = [
  'ask an administrator of this business to restore your access',
] as const;

/**
 * A login here with no standing: `AUTH_ACCESS_ENDED` when its access was ended
 * here (C58), so a client that never saw it served (a reload) still signs the
 * person out; otherwise `AUTH_NO_MEMBERSHIP`. Only this business's endings of
 * this login are read, so it says nothing the login did not already hold.
 */
export async function noMembership(tx: TenantQuery, loginId: string): Promise<Refusal> {
  const ended = await tx.query(
    `select 1 from public.access_endings where business_id = $1 and login_id = $2 limit 1`,
    [tx.businessId, loginId],
  );
  return ended.length > 0
    ? refuse('AUTH_ACCESS_ENDED', ACCESS_ENDED_FIXES)
    : refuse('AUTH_NO_MEMBERSHIP', NO_MEMBERSHIP_FIXES);
}
