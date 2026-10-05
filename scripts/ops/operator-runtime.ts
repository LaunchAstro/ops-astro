// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's own reads and acts on the installation's database
// (operator.ts): the business key, read as the lookup identity before anyone
// is admitted; then, as the runtime identity once a person is, the sign-in
// record after the act (I13), and the short hold a store part read starts
// under (restore-drill.mjs). Each act opens a connection of its own and
// closes it.

import { createBusinessResolver, LOOKUP_ROLE } from '../../apps/api/server.ts';
import {
  connect,
  OPERATIONS_MANAGE,
  withSession,
  type AdminConnection,
  type BusinessId,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';

const CANNOT_TAKE_LOOKUP =
  `DATABASE_ADMIN_URL's login may not take the business lookup identity (${LOOKUP_ROLE}), ` +
  'so the sign-in cannot be checked: migration 20261005063514 grants it, with set true and inherit false';

/**
 * The business `key` names, read on `admin` as the server reads it, or
 * undefined. A database the lookup identity (0046) may not read holds no
 * business; an admin login that may not take the identity is no fault of the
 * operator's, so it is named (`why`) rather than answered as no business.
 */
export async function businessOf(
  admin: AdminConnection,
  key: string,
): Promise<string | undefined | { readonly why: string }> {
  try {
    return await createBusinessResolver(admin)(key);
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42501') throw error;
    const [may] = await admin.execute<{ set: boolean }>("select pg_has_role($1, 'SET') as set", [
      LOOKUP_ROLE,
    ]);
    return may?.set === true ? undefined : { why: CANNOT_TAKE_LOOKUP };
  }
}

/** Record the admitted operator's sign-in attempt (I13), in a transaction of its own. */
export async function recordSignIn(
  url: string,
  businessId: BusinessId,
  presented: VerifiedSubject,
): Promise<void> {
  const database = connect(url, { source: 'runtime' });
  try {
    await withSession(database, businessId, presented, async () => {});
  } finally {
    await database.close();
  }
}

/**
 * `during`, handed `release`, with the person's live `operations:manage`
 * grants held FOR SHARE in a transaction of its own until it calls `release`
 * or ends: a revocation of them waits that long and no longer.
 */
export async function holdingGrant<T>(
  url: string,
  businessId: BusinessId,
  personId: string,
  during: (release: () => void) => Promise<T>,
): Promise<T> {
  const database = connect(url, { source: 'runtime' });
  let [release, held] = [(): void => {}, (): void => {}];
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    held = resolve;
  });
  const hold = database.withBusiness(businessId, async (tx) => {
    await tx.query(
      'select id from public.grants where subject_id = $1 and collection = $2 and action = $3 and revoked_at is null for share',
      [personId, OPERATIONS_MANAGE.collection, OPERATIONS_MANAGE.action],
    );
    held();
    await released;
  });
  try {
    await Promise.race([taken, hold]);
    return await during(release);
  } finally {
    release();
    try {
      await hold;
    } finally {
      await database.close();
    }
  }
}
