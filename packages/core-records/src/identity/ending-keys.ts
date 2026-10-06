// SPDX-License-Identifier: AGPL-3.0-only
//
// The session-ending keys (C52-A, PRV-oa-984-R2.1). An ending and a write's
// last ask after its session (`sessionEndedHeld`, sessions.ts) take the same
// keys in one order: the business's audit chain, the login's subject, then
// each session, the ending exclusively and the ask shared. An ending through
// another business so either commits before the ask reads the endings, or
// waits for the asking write to commit. A reset's window (C40) is an ending
// of the subject: its open takes the subject's key alone, as it writes no
// audit event; its ending in each business and its settle, which ends
// sessions signed in after the window's bound too, take the keys first
// (`holdSubjectEnding`).

import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';

export const subjectKey = (subject: string): string => `session-ending:subject:${subject}`;
export const sessionKey = (sessionId: string): string =>
  `session-ending:session:${sessionId.toLowerCase()}`;

/** An ending's keys, exclusively, in the one order: chain, subject, sessions sorted. */
export async function holdEnding(
  tx: TenantQuery,
  subject: string | undefined,
  sessionIds: readonly string[],
): Promise<void> {
  await advisoryLock(tx, tx.businessId.toLowerCase());
  if (subject !== undefined) await advisoryLock(tx, subjectKey(subject));
  for (const key of [...new Set(sessionIds.map((id) => sessionKey(id)))].toSorted()) {
    // eslint-disable-next-line no-await-in-loop -- one key after another, in order
    await advisoryLock(tx, key);
  }
}

/**
 * The subject's ending keys, exclusively, for a transaction that ends the
 * login's sessions as a whole (C40's ending in each business, and its settle):
 * taken first, before any session key, in `holdEnding`'s order.
 */
export async function holdSubjectEnding(tx: TenantQuery, subject: string): Promise<void> {
  await holdEnding(tx, subject, []);
}
