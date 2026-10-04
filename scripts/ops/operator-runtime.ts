// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator gate's own act on the installation's database, as the runtime
// identity, once it has admitted a person (operator.ts): the sign-in record
// after the act (I13). It opens a connection of its own and closes it.

import {
  connect,
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
