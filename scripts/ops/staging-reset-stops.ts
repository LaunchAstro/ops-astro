// SPDX-License-Identifier: AGPL-3.0-only
//
// Why a staging reset stops, in words that carry no address or login.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { otherSessions } from '../../packages/core-records/src/tenancy/migrate.ts';
import { Refusal } from './staging-reset.ts';

// Migration 20261006140500's stop: a closed list of plain names, so no address.
const NAME = String.raw`(?:schema )?[a-z_][a-z0-9_]{0,62}(?:\.[a-z_][a-z0-9_]{0,62})?`;
const BACKUP_GAP = new RegExp(
  String.raw`^the backup identity cannot read ${NAME}(?:, ${NAME}){0,49}$`,
  'u',
);

/**
 * Why a run stopped: the backup identity's gap by name, any other error by its
 * class and SQLSTATE alone, since its message may carry an address.
 */
export function stoppedBecause(error: unknown): string {
  const { cause } = (error ?? {}) as { cause?: { code?: unknown; message?: unknown } };
  if (
    cause?.code === '42501' &&
    typeof cause.message === 'string' &&
    BACKUP_GAP.test(cause.message)
  )
    return cause.message;
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return [
    typeof name === 'string' ? name : 'error',
    typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Refuses while any other session is connected, by the rule the migrations
 * apply, so the reset stops before it empties anything. The session pooler
 * keeps a login's connection open, idle, after its client leaves, this
 * login's too, so the refusal counts those apart, by number only.
 */
export async function refuseOtherSessions(execute: AdminConnection['execute']): Promise<void> {
  const others = await otherSessions(execute);
  if (others.length === 0) return;
  const [row] = await execute<{ me: string }>('select current_user::text as me');
  const mine = others.filter(({ usename }) => usename === row?.me).length;
  throw new Refusal(
    `${others.length} other ${others.length === 1 ? 'session is' : 'sessions are'} connected, ` +
      `${mine} of them as this login: stop the app's worker, forwarder and web, then wait ` +
      'until the pooler drops its idle connections; nothing was emptied',
  );
}
