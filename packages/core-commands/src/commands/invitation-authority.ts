// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: what an invitation act asks of its caller beyond the envelope's
// `access:share`, and the same asked again once the act holds its locks.

import { checkAuthority, subjectsOf, type TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';

/** The role whose invitation also asks `access:manage`. */
export const ADMIN_ROLE = 'admin';

/** Refused unless the caller holds `access:manage` on the whole business. */
export async function notManager(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome | undefined> {
  const held = await checkAuthority(tx, subjectsOf(context.session), {
    collection: 'access',
    action: 'manage',
    scope: { kind: 'business', id: null },
  });
  if (held.ok) return undefined;
  return refused(
    refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['role'],
      ['Only a person with access:manage on the whole business invites an administrator.'],
    ),
  );
}

/**
 * Asked again once every lock is held: a grant revoked while the act waited
 * (at the limiter or the invitation's row) refuses it, writing nothing. The
 * envelope asked `access:share` before the wait; an administrator's
 * invitation asks `access:manage` too.
 */
export async function noLongerHeld(
  tx: TenantQuery,
  context: CommandContext,
  role: string,
): Promise<HandlerOutcome | undefined> {
  const shares = await checkAuthority(tx, subjectsOf(context.session), {
    collection: 'access',
    action: 'share',
    scope: { kind: 'business', id: null },
  });
  if (!shares.ok) {
    return refused(
      refuseCommand('SCOPE_NOT_GRANTED', [], ['no live grant of access:share covers it']),
    );
  }
  return role === ADMIN_ROLE ? await notManager(tx, context) : undefined;
}
