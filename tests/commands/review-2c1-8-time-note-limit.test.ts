// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-8 (REVIEW-BATCH #305, batch 2c1): the time note limit disagrees
// with the table. tasks-time.ts admits a note of up to NOTE_LIMIT = 2000
// characters, and 0078's time_entries_note_bounded check holds
// char_length(note) <= 500. A note of 501 to 2000 characters passes the
// handler and meets the check, so time.log and time.set_note fault inside the
// transaction instead of refusing the note by name. Once the handler's limit
// is the table's (500), both are refused FIELD_VALUE_INVALID ['note'] and
// nothing is written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Member } from './fixture.ts';
import { entryIdOf, outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('review-2c1-8: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const TOO_LONG = 'x'.repeat(501);
const NOTE_REFUSED = { code: 'FIELD_VALUE_INVALID', names: ['note'] };

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('rb2c1n8');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

/** The command's outcome, or the fault it threw, so a fault reads as a failed expectation. */
async function answerOf(member: Member, body: Record<string, unknown>) {
  try {
    return outcomeOf(await w.as(w.alpha, member, body));
  } catch (error) {
    return { fault: error instanceof Error ? error.message : String(error) };
  }
}

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-8: the note limit is the table’s', () => {
  it('REVIEW-2C1-8: time.log with a 501-character note is refused FIELD_VALUE_INVALID [note], not a fault, and writes no entry', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'long note log');
    const answer = await answerOf(w.ada, {
      command: 'time.log',
      taskId: task,
      duration: '20m',
      note: TOO_LONG,
    });
    expect(answer).toStrictEqual(NOTE_REFUSED);
    expect(await w.entries(task)).toStrictEqual([]);
  });

  it('REVIEW-2C1-8: time.set_note with a 501-character note is refused FIELD_VALUE_INVALID [note], not a fault, and the note is unchanged', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'long note set');
    const entryId = entryIdOf(
      await w.as(w.alpha, w.ada, { command: 'time.log', taskId: task, duration: '20m' }),
    );
    const answer = await answerOf(w.ada, {
      command: 'time.set_note',
      entryId,
      note: TOO_LONG,
    });
    expect(answer).toStrictEqual(NOTE_REFUSED);
    expect((await w.entries(task)).map((row) => row.note)).toStrictEqual(['']);
  });

  it('REVIEW-2C1-8 control: a 500-character note is the most the table holds, and it applies', async () => {
    const task = await w.fresh(w.alpha, w.ada, 'longest note');
    const answer = await answerOf(w.ada, {
      command: 'time.log',
      taskId: task,
      duration: '20m',
      note: 'x'.repeat(500),
    });
    expect(answer).toStrictEqual({ applied: true });
  });
});
