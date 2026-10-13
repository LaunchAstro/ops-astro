// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid send rests on its admission: the transaction that judged the grant,
// the session, the conversation and the page holds them until custody has the
// request, so a revocation either is seen first (nothing is sent) or waits
// until the send is out. One send at most, and never after a revocation has
// committed.
//
// Here the admission's connection is lost once it has admitted the send and
// before custody has started it, as a pooler restart or a dropped socket ends
// it: its locks go with it. A revocation then commits at once. Whatever the
// broker does next, no request may reach OpenRouter after that commit.
//
// The driver answers a commit sent on a connection the server already ended
// with a TypeError thrown from its write timer. That error is the lost
// connection's, not the case's, so it is set aside here; any other uncaught
// error still fails the case.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { CONVERSATION } from '../api/aw-03-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, type PricedWorld } from './priced-chat-world.ts';
import { parkedAt, steppedCustody, until } from './paid-schedule-support.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The driver's write on a socket the server closed: `socket.write` on null, in its write timer. */
const lostConnectionWrite = (error: unknown): boolean =>
  error instanceof TypeError &&
  /reading 'write'/u.test(error.message) &&
  /postgres[/\\]src[/\\]connection\.js/u.test(error.stack ?? '');

// oxlint-disable-next-line max-lines-per-function -- one world and its one schedule
describe.skipIf(serverUrl === undefined)('a paid send whose admission is lost', () => {
  let p: PricedWorld;
  const other: unknown[] = [];

  beforeAll(async () => {
    p = await pricedWorld('priced_admission_lost');
    process.setUncaughtExceptionCaptureCallback((error) => {
      if (!lostConnectionWrite(error)) other.push(error);
    });
  }, 180_000);

  afterAll(async () => {
    process.setUncaughtExceptionCaptureCallback(null);
    await p?.stop();
  });

  it('a revocation that commits after the admission is lost: nothing reaches OpenRouter', async () => {
    const { db, business } = p.w.fixture;
    const asked = await p.question('What is due today?');
    const sent = p.openrouter.received.length;
    let revokedAt = -1;
    // Once the send is admitted, before custody has it: the admission's backend ends, then
    // the grant is revoked, which no longer waits on anything.
    const loseTheAdmission = async (): Promise<void> => {
      let pids: readonly number[] = [];
      await until(async () => {
        pids = await parkedAt(p, '%scope_record_id as page%');
        return pids.length === 1;
      }, 'the admission parked open');
      await db.admin.execute('select pg_terminate_backend($1)', [pids[0]]);
      await until(
        async () => (await parkedAt(p, '%scope_record_id as page%')).length === 0,
        'the admission gone',
      );
      await db.admin.execute(
        `update public.grants set revoked_at = clock_timestamp()
          where business_id = $1 and collection = 'conversation' and revoked_at is null
            and subject_id in ($2, $3)`,
        [business, p.w.owner.personId, p.w.owner.actorId],
      );
      revokedAt = p.openrouter.received.length;
    };
    const exchange = await p.twin(
      steppedCustody(async () => await Promise.resolve(), loseTheAdmission),
    );
    // Two connections: the lost one, and one for whatever the broker does after.
    const own = connect(db.appUrl, { max: 2 });
    await exchange(own, business, p.w.owner.presented, asked).catch(() => null);
    // The lost connection never finishes its commit, so its pool is not waited on.
    await Promise.race([own.close(), delay(2_000)]);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, p.w.owner, 'write', undefined, false, CONVERSATION);
    });
    expect(other).toStrictEqual([]);
    expect(revokedAt).toBe(sent);
    // The revocation committed before custody was handed the request: nothing may go out.
    expect(p.openrouter.received.length).toBe(sent);
  });
});
