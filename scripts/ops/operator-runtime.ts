// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's own acts on the installation's database, as the runtime
// identity, once it has admitted a person (operator.ts): the sign-in record
// after the act (I13), and the hold each store part read runs under
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
 * `during`, run while the business's live `operations:manage` grants are held
 * FOR SHARE in a transaction of its own: locked, not read, so a revocation of
 * any of them waits until `during` has ended.
 */
export async function holdingOperations<T>(
  url: string,
  businessId: BusinessId,
  during: () => Promise<T>,
): Promise<T> {
  const database = connect(url, { source: 'runtime' });
  try {
    return await database.withBusiness(businessId, async (tx) => {
      await tx.query(
        'select id from public.grants where collection = $1 and action = $2 and revoked_at is null for share',
        [OPERATIONS_MANAGE.collection, OPERATIONS_MANAGE.action],
      );
      return await during();
    });
  } finally {
    await database.close();
  }
}
