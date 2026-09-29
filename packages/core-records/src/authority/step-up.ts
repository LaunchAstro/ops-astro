// SPDX-License-Identifier: AGPL-3.0-only
//
// The one step-up check (C59): money actions only, sixty minutes, judged once
// inside the grant check.
//
// The owner's ruling of 28 September 2026 narrowed the re-check to the money
// set and set its window here, in one place. No ticket wires its own call: a
// command whose declared key is in the money set is judged by the envelope
// straight after its grant check (`prepare.ts`), so a money command added later
// is covered the day it is declared.
//
// The window runs from the second-factor time the sign-in recorded, which a
// token refresh carries unchanged (`apps/api/auth/supabase.ts`). A team member
// steps up with the second factor. A client, who may have none, signs in
// afresh. While the installation's `money_step_up_required` setting is off, a
// live session is enough; only `settings:manage` switches it, through
// `settings.set_money_step_up`, and the envelope audits every switch.

import { refuseCommand, type CommandRefusal } from '../register.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import type { Assurance } from '../identity/verified-subject.ts';
import { readBusinessSetting } from '../records/business-settings.ts';
import type { Action } from './grants.ts';

/** Sixty minutes: the owner's step-up window, and the only place it is set. */
export const STEP_UP_WINDOW_SECONDS: number = 60 * 60;

/** The business setting that switches the money step-up; on by default. */
export const MONEY_STEP_UP_SETTING: string = 'money_step_up_required';

/**
 * Tolerance for a factor time ahead of the database clock, which is the
 * provider's clock against ours. Beyond it the time is not believed.
 */
const CLOCK_SKEW_SECONDS = 60;

/**
 * The money set, from the permission key catalogue: every `billing` key,
 * `offer:decide`, `mandate:manage` and `spend:decide` (billing, invoices and
 * Xero drafts, payment links, ad spend and budgets, accepting a priced offer).
 */
export function isMoneyKey(collection: string, action: Action): boolean {
  return (
    collection === 'billing' ||
    (collection === 'offer' && action === 'decide') ||
    (collection === 'mandate' && action === 'manage') ||
    (collection === 'spend' && action === 'decide')
  );
}

export interface Standing {
  /** Null for a client person, who stands on shares and may have no factor. */
  readonly roleKey: string | null;
  readonly assurance: Assurance;
}

/**
 * Whether a sign-in is recent enough for a money action at `now` (epoch
 * seconds). A team member needs the second factor inside the window; a client
 * needs a sign-in inside it, with or without one. A time ahead of the clock by
 * more than the skew is stale, never fresh.
 */
export function judgeStepUp(standing: Standing, now: number): 'fresh' | 'stale' {
  const { assurance } = standing;
  const factor = assurance.level === 'aal2' ? assurance.factorAt : null;
  const at = standing.roleKey === null ? latest(factor, assurance.signedInAt) : factor;
  if (at === null) return 'stale';
  const age = now - at;
  return age <= STEP_UP_WINDOW_SECONDS && age >= -CLOCK_SKEW_SECONDS ? 'fresh' : 'stale';
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

const STEP_UP_FIXES: readonly string[] = [
  'Sign in again with the code from your authenticator app, then retry.',
  'A money action needs a sign-in with the second factor in the last 60 minutes.',
];

/**
 * The envelope's step-up, asked after the grant check has passed. Nothing for
 * a key outside the money set or while the setting is off; otherwise the
 * judgement against the database's own clock, inside the serving transaction.
 * An absent setting row is read as on, so a business that never installed it
 * is not quietly exempt.
 */
export async function refuseStaleMoneyStep(
  tx: TenantQuery,
  standing: Standing,
  key: { readonly collection: string; readonly action: Action },
): Promise<CommandRefusal | undefined> {
  if (!isMoneyKey(key.collection, key.action)) return undefined;
  const setting = await readBusinessSetting(tx, MONEY_STEP_UP_SETTING);
  if (setting !== undefined && setting.value === false) return undefined;
  // Whole seconds, as the token's times are: the boundary is one second either
  // side of sixty minutes, and a fraction of the clock is not a second.
  const rows = await tx.query<{ readonly now: number }>(
    'select floor(extract(epoch from now()))::float8 as now',
  );
  const now = rows[0]?.now ?? Number.POSITIVE_INFINITY;
  if (judgeStepUp(standing, now) === 'fresh') return undefined;
  return refuseCommand('STEP_UP_REQUIRED', [], STEP_UP_FIXES);
}
