// SPDX-License-Identifier: AGPL-3.0-only
//
// What the database keeps of carriage on a project with Realtime. Hosted
// Realtime stores a database broadcast in `realtime.messages` (three days,
// replayable); the shim stores it the same way, so the check below can see
// one. Positive control first: a call-topic message sent from the database,
// with words in it, is found. Then the database's own sends on the carriage
// path: an offer rings the agent's doorbell, and the only stored row is that
// doorbell, on the agent's own topic, carrying the conversation and call ids
// and nothing else; no call topic is stored and no row holds a word of the
// conversation. The agent hears the ring through the hub; another agent may
// not even join the doorbell.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createRealtimeDatabase, type RealtimeDatabase } from '../support/realtime-database.ts';
import { realtimeHub, type RealtimeHub } from '../support/realtime-hub.ts';
import {
  callTopic,
  carriageBusiness,
  doorbellTopic,
  type CarriageBusiness,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = 'What is due today?';

interface Stored {
  readonly topic: string;
  readonly event: string | null;
  readonly payload: unknown;
  readonly private: boolean;
}

/** The check: every stored carriage row on a call topic, or holding the conversation's words. */
const storedCarriage = async (admin: AdminConnection, words: string) =>
  await admin.execute<Stored>(
    `select topic, event, payload, private from realtime.messages
      where topic like 'carry:%:call:%' or payload::text like '%' || $1 || '%'
      order by inserted_at`,
    [words],
  );

const allStored = async (admin: AdminConnection) =>
  await admin.execute<Stored>(
    `select topic, event, payload, private from realtime.messages order by inserted_at`,
  );

const sleep = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// eslint-disable-next-line max-lines-per-function -- one project with Realtime, a control and the path
describe.skipIf(serverUrl === undefined)('carriage text kept at rest in realtime.messages', () => {
  let db: RealtimeDatabase;
  let hub: RealtimeHub;
  let alpha: CarriageBusiness;

  beforeAll(async () => {
    db = await createRealtimeDatabase('carriage_at_rest');
    hub = await realtimeHub(db.adminUrl);
    alpha = await carriageBusiness(db.app, 'alpha');
  }, 240_000);

  afterAll(async () => {
    await hub?.close();
    await db?.drop();
  });

  it('control: a call topic sent from the database, words and all, is found by the check', async () => {
    const topic = callTopic(alpha.id, alpha.callId);
    await db.admin.execute(`select realtime.send($1::jsonb, 'request', $2, true)`, [
      JSON.stringify({ messages: [{ role: 'user', content: WORDS }] }),
      topic,
    ]);
    const found = await storedCarriage(db.admin, WORDS);
    expect(found.map((row) => row.topic)).toStrictEqual([topic]);
    await db.admin.execute('delete from realtime.messages');
    expect(await allStored(db.admin)).toHaveLength(0);
  });

  it('an offer rings the agent alone, by id, and stores no call topic and no words', async () => {
    const bell = doorbellTopic(alpha.id, alpha.agent.actor);
    const listening = await hub.join(bell, { sub: alpha.agent.sub });
    expect(await hub.join(bell, { sub: alpha.otherAgent.sub })).toBe('refused');
    if (listening === 'refused') throw new Error('the agent may not join its own doorbell');
    await db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query(
        `update model_call_carriers set offered_at = clock_timestamp()
          where business_id = $1 and call_id = $2`,
        [alpha.id, alpha.callId],
      );
    });
    const ids = { c: alpha.conversationId, k: alpha.callId };
    expect(await allStored(db.admin)).toEqual([
      { topic: bell, event: 'offer', payload: ids, private: true },
    ]);
    expect(await storedCarriage(db.admin, WORDS)).toHaveLength(0);
    for (let tries = 0; tries < 200 && listening.heard.length === 0; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the hub's delivery
      await sleep(10);
    }
    expect(listening.heard).toStrictEqual([{ event: 'offer', payload: ids }]);
  });

  it('an offer rings once: the offer is set once and a second set is refused', async () => {
    await expect(
      db.app.withBusiness(alpha.id, async (tx) => {
        await tx.query(
          `update model_call_carriers set offered_at = clock_timestamp()
            where business_id = $1 and call_id = $2`,
          [alpha.id, alpha.callId],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await allStored(db.admin)).toHaveLength(1);
  });
});
