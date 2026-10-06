// SPDX-License-Identifier: AGPL-3.0-only
//
// R7: an owner's `conversation.read` that overlaps the scheduled purge
// answers one whole record: the transcript as it was before the purge, or the
// wrap-up with no transcript after it, never an empty transcript marked
// unpurged beside its wrap-up (the conversation screen shows that empty
// transcript and hides the wrap-up). The read runs on its own connection and
// pauses just after it has read the conversation's row, or its body; a sweep
// round on a second connection purges the body and commits; then the read
// goes on.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepRound } from '../../apps/api/conversation-sweeper.ts';
import { readConversation } from '../../packages/core-commands/src/reads/conversation.ts';
import { standingOf, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { raisedFailures, REVISION, sweeperWorld, type SweeperWorld } from './r7-sweeper-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let s: SweeperWorld;
let second: Database;

/** Where the read pauses: just after the statement that reads the conversation's row, or its body. */
const PAUSES = [
  ['row', /\bpage_shows\b/u],
  ['body', /from conversation_messages/u],
] as const;

/** `tx`, which runs `between` once, just after the first statement `at` matches. */
function pausedAfter(at: RegExp, tx: TenantQuery, between: () => Promise<void>): TenantQuery {
  let paused = false;
  return {
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
      const rows = await tx.query<Row>(text, parameters);
      if (!paused && at.test(text)) {
        paused = true;
        await between();
      }
      return rows;
    },
  };
}

/**
 * A wrapped conversation, due, read by its owner on one connection while a
 * round on the other purges it at `at`: the answer is one whole record.
 */
async function readBesideThePurge(at: RegExp): Promise<void> {
  const due = await s.dueInAlpha(`CANARY-${randomUUID()} the body the purge takes`);
  const { failures, raise } = raisedFailures();
  const round = sweepRound(second, {
    businesses: async () => await Promise.resolve([s.alpha]),
    codeRevision: REVISION,
    raise,
  });
  await round();
  expect(await s.wrapUps(due)).toBe(1);
  expect(await s.messages(due)).toBe(1);

  let purgedDuringTheRead = false;
  const read = await s.db.withBusiness(s.alpha, async (tx) => {
    const session = await standingOf(tx, s.w.owner.presented, 'required');
    if ('refused' in session) throw new Error('the owner does not stand');
    const purgedMeanwhile = async (): Promise<void> => {
      purgedDuringTheRead = true;
      await round();
      expect(await s.messages(due), 'the purge did not commit while the read waited').toBe(0);
    };
    return await readConversation(pausedAfter(at, tx, purgedMeanwhile), session, due);
  });

  expect(purgedDuringTheRead, 'the read never paused').toBe(true);
  expect(failures).toEqual([]);
  if (!('conversation' in read)) throw new Error(`refused: ${JSON.stringify(read)}`);
  const seen = {
    bodyPurged: read.conversation.bodyPurgedAt !== null,
    messages: read.messages?.length ?? null,
    wrapUp: read.wrapUp !== null,
  };
  const beforeThePurge = { bodyPurged: false, messages: 1, wrapUp: true };
  const afterThePurge = { bodyPurged: true, messages: null, wrapUp: true };
  expect([beforeThePurge, afterThePurge], JSON.stringify(seen)).toContainEqual(seen);
}

describe.skipIf(serverUrl === undefined)('R7 conversation read beside the purge', () => {
  beforeAll(async () => {
    s = await sweeperWorld('r7_read_beside_purge');
    second = connect(s.w.fixture.db.appUrl, { source: 'runtime' });
    await s.window(s.alpha, 7);
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await s?.w.drop();
  });

  it.each(PAUSES)(
    'R7 a read paused after its %s while the purge commits answers the transcript or the wrap-up, never an empty transcript',
    async (_, at) => {
      await readBesideThePurge(at);
    },
  );
});
