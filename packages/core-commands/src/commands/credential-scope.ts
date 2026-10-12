// SPDX-License-Identifier: AGPL-3.0-only
//
// The keys an agent credential carries (API-2), judged the same way when it is
// issued and when its issuer's replay derives its secret again
// (`credential-write.ts`). Every credential is an agent's, so a key the
// permission key catalogue (CAPABILITY-SLICES.md) says no agent may hold is
// never carried, whatever the issuer holds: decide, share or manage, a money
// key (C59's set, `isMoneyKey`), or one of `AGENT_NEVER_HOLDS`. Every other
// ticked key is one the issuer holds across the whole business, asked under
// the business's access lock.

import {
  checkAuthority,
  CREDENTIAL_EXCLUDED_ACTIONS,
  isMoneyKey,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type {
  Action,
  CredentialKey,
  Session,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

export const MAX_KEYS = 32;
const COLLECTION = /^[a-z][a-z_]{0,39}$/u;
const ACTIONS: ReadonlySet<string> = new Set<Action>([
  'read',
  'comment',
  'write',
  'assign',
  'decide',
  'share',
  'manage',
]);
const EXCLUDED: ReadonlySet<string> = new Set(CREDENTIAL_EXCLUDED_ACTIONS);
const WHOLE_BUSINESS = { kind: 'business', id: null } as const;

/**
 * The catalogue's keys no agent may hold that neither the excluded actions nor
 * the money set already cover.
 */
const AGENT_NEVER_HOLDS: ReadonlySet<string> = new Set([
  'account:write',
  'chat:comment',
  'conversation:read',
  'credential:write',
  'operations:read',
]);

/** The ticked keys, shaped, or undefined when any one is not a key. */
export function keysOf(scope: unknown): readonly CredentialKey[] | undefined {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > MAX_KEYS) return undefined;
  const keys: CredentialKey[] = [];
  const seen = new Set<string>();
  for (const one of scope as readonly unknown[]) {
    if (typeof one !== 'object' || one === null || Array.isArray(one)) return undefined;
    const { collection, action, ...rest } = one as Readonly<Record<string, unknown>>;
    if (Object.keys(rest).length > 0) return undefined;
    if (typeof collection !== 'string' || !COLLECTION.test(collection)) return undefined;
    if (typeof action !== 'string' || !ACTIONS.has(action)) return undefined;
    const key = `${collection}:${action}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    keys.push({ collection, action: action as Action });
  }
  return keys;
}

/** The keys a stored credential carries, from their `collection:action` form. */
export const storedKeys = (scope: readonly string[]): readonly CredentialKey[] =>
  scope.map((key) => {
    const [collection = '', action = ''] = key.split(':');
    return { collection, action: action as Action };
  });

// CAPABILITY-SLICES.md: an agent may hold no money key, billing:read included.
const MONEY = refuseCommand(
  'CREDENTIAL_MONEY_KEY_EXCLUDED',
  ['scope'],
  [
    'An agent credential never carries a billing key, offer:decide, mandate:manage or spend:decide.',
    'Untick them; money actions stay with a person.',
  ],
);

const NEVER_CARRIED = refuseCommand(
  'CREDENTIAL_ACTION_EXCLUDED',
  ['scope'],
  [
    'An agent credential never carries decide, share or manage.',
    `Nor ${[...AGENT_NEVER_HOLDS].join(', ')}: no agent may hold them. Untick them.`,
  ],
);

const WIDENS = refuseCommand(
  'CREDENTIAL_SCOPE_WIDENS',
  ['scope'],
  ['Tick only keys you hold across the whole business.'],
);

/** The refusal for a key no agent credential carries, whoever issues it, or undefined. */
export function refuseNeverCarried(keys: readonly CredentialKey[]): CommandRefusal | undefined {
  if (keys.some((key) => isMoneyKey(key.collection, key.action))) return MONEY;
  const never = keys.some(
    (key) => EXCLUDED.has(key.action) || AGENT_NEVER_HOLDS.has(`${key.collection}:${key.action}`),
  );
  return never ? NEVER_CARRIED : undefined;
}

/** A ticked key the caller does not hold at business scope, or undefined. */
export async function refuseScope(
  tx: TenantQuery,
  session: Session,
  keys: readonly CredentialKey[],
): Promise<CommandRefusal | undefined> {
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one grant walk per key, in order
    const decision = await checkAuthority(tx, subjectsOf(session), {
      ...key,
      scope: WHOLE_BUSINESS,
    });
    if (!decision.ok) return WIDENS;
  }
  return undefined;
}

/**
 * The database's clock in milliseconds: its transaction's start, the instant
 * a row's `now()` default stamps, or this statement's instant.
 */
export async function databaseClock(
  tx: TenantQuery,
  reading: 'now()' | 'clock_timestamp()',
): Promise<number> {
  const rows = await tx.query<{ readonly at: Date }>(`select ${reading} as at`);
  return new Date(rows[0]?.at ?? Number.NaN).getTime();
}
