// SPDX-License-Identifier: AGPL-3.0-only
//
// An archive added to the backup store as the job adds one, through the
// backup identity's two functions (deploy/staging/backup-store.sql), for the
// S0-3 store suites (backup-identity.fixture.ts re-exports it).

import { createHash } from 'node:crypto';

/** A session the store suites hold (backup-identity.fixture.ts's Client). */
type Client = { query: (text: string, values?: unknown[]) => Promise<unknown> };

/** The store's part size (deploy/staging/backup-store.sql). */
export const PART: number = 4 * 1024 * 1024;

/**
 * Adds `body` to the store through the backup identity's two functions, as
 * the job does: in parts, then completed with its size and whole digest (and
 * the restore challenge's sha256, when there is one). In
 * its own transaction unless `open` says the caller holds one.
 */
export async function addArchive(
  client: Client,
  body: Buffer,
  open = false,
  challengeSha256: string | null = null,
): Promise<void> {
  if (!open) await client.query('begin');
  try {
    for (let seq = 0; seq * PART < body.length; seq += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await client.query('select backups.add_part($1, $2)', [
        seq,
        body.subarray(seq * PART, (seq + 1) * PART),
      ]);
    }
    const digest = createHash('sha256').update(body).digest('hex');
    await client.query('select backups.complete_archive($1, $2, $3)', [
      body.length,
      digest,
      challengeSha256,
    ]);
    if (!open) await client.query('commit');
  } catch (error) {
    if (!open) await client.query('rollback');
    throw error;
  }
}
