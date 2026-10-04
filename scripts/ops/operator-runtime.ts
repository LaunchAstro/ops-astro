// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's own acts on the installation's database, as the runtime
// identity, once it has admitted a person (operator.ts): the sign-in record
// after the act (I13), and the short hold a store part read starts under
// (restore-drill.mjs). Each opens a connection of its own and closes it.

import {
  connect,
  OPERATIONS_MANAGE,
  withSession,
  type BusinessId,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';

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
