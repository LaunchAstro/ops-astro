// SPDX-License-Identifier: AGPL-3.0-only
//
// The stamp-owed note beside a carried receipt (drill-acts.mjs, `recordCarried`):
// the store took the receipt's pass but the date of the last tested restore was
// not written. A re-run of --record holds the note, renamed `<note>.<pid>`, while
// it stamps, and removes it only once the stamp is written. A note held by a run
// that has since died is held again by the next one; a live run's is left alone.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Notes beside the receipt that the store took `archiveId`'s pass and its stamp is owed. */
export function noteOwed(owed, archiveId, stampError) {
  try {
    writeFileSync(owed, JSON.stringify({ archiveId }), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Error(
      `${stampError.message}; and the note to finish it, ${owed}, could not be written either, ` +
        'so a re-run of --record cannot stamp this pass (the store has its receipt): ' +
        'run select ops.record_tested_restore() with DATABASE_ADMIN_URL',
      { cause: stampError },
    );
  }
}

/** Whether a process holding a note (`<note>.<pid>`) may still be stamping. */
function stamping(pid) {
  try {
    return !/^\d+$/u.test(pid) || process.kill(Number(pid), 0);
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * `archiveId`'s stamp-owed note, or one a re-run killed before stamping held,
 * renamed `<note>.<pid>` for this process to stamp: only one run holds it.
 */
export function holdOwed(owed, archiveId) {
  const prefix = `${basename(owed)}.`;
  const orphans = readdirSync(dirname(owed)).filter(
    (name) => name.startsWith(prefix) && !stamping(name.slice(prefix.length)),
  );
  for (const note of [owed, ...orphans.map((name) => join(dirname(owed), name))]) {
    if (!existsSync(note)) continue;
    let noted;
    try {
      noted = JSON.parse(readFileSync(note, 'utf8'));
    } catch {}
    if (typeof noted?.archiveId !== 'string' || !UUID.test(noted.archiveId)) {
      throw new Error(
        `the stamp-owed note ${note} is not one --record wrote: remove it only if the store has not taken this receipt`,
      );
    }
    if (noted.archiveId !== archiveId) throw new Error('the stamp owed is of another archive');
    try {
      renameSync(note, `${owed}.${process.pid}`);
      return `${owed}.${process.pid}`;
    } catch {}
  }
}
