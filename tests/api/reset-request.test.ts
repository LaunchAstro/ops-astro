// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/password/reset` answers every address alike: 202 and an empty
// body, known or unknown, inside its limits or over them, with the same
// statements sent. Each hour an address may ask 3 times and a caller 10, and
// requests at once cannot pass either limit. Over a throwaway database, through
// the server's own composition.

import { createHash, randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createStatementLog } from '../../packages/core-records/src/tenancy/statements.ts';
import { createApiFixture, type Answer, type ApiFixture } from './fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
const withDatabase = it.skipIf(serverUrl === undefined);
const PATH = '/api/password/reset';

let fixture: ApiFixture;
let pool: Database;
let api: Hono;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('rstreq');
  // Twenty requests at once each hold a connection of their own.
  pool = connect(fixture.db.appUrl, { max: 20 });
  api = fixture.compose(undefined, undefined, pool);
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await fixture?.drop();
});

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function ask(target: Hono, body: unknown, caller = '203.0.113.9'): Promise<Answer> {
  const response = await target.fetch(
    new Request(`http://api.test${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${caller}, 10.0.0.1` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  try {
    return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
  } catch {
    return { status: response.status, body: { raw: text } };
  }
}

const rowsFor = async (column: 'address' | 'caller_digest', value: string): Promise<number> =>
  (
    await fixture.db.admin.execute(
      `select 1 from ops.password_reset_requests where ${column} = $1`,
      [value],
    )
  ).length;

async function earlier(address: string, count: number): Promise<void> {
  await fixture.db.admin.execute(
    `insert into ops.password_reset_requests (id, address, caller_digest)
     select gen_random_uuid(), $1, $2 from generate_series(1, $3)`,
    [address, digest('198.51.100.7'), count],
  );
}

withDatabase(
  'answers 202 and an empty body for a known, an unknown and an over-limit address, with the same statements',
  async () => {
    const known = `known-${randomUUID()}@example.test`;
    const unknown = `unknown-${randomUUID()}@example.test`;
    const over = `over-${randomUUID()}@example.test`;
    await earlier(known, 1);
    await earlier(over, 3);
    const sent: string[][] = [];
    for (const address of [known, unknown, over]) {
      const log = createStatementLog();
      const logged = connect(fixture.db.appUrl, { log });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one composition per address
        const answer = await ask(fixture.compose(undefined, undefined, logged), {
          email: address,
        });
        expect(answer, address).toStrictEqual({ status: 202, body: {} });
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await logged.close();
      }
      sent.push(log.entries.map((entry) => entry.text));
    }
    expect(sent[0]?.length).toBeGreaterThan(0);
    expect(sent[1]).toStrictEqual(sent[0]);
    expect(sent[2]).toStrictEqual(sent[0]);
    expect(await rowsFor('address', known)).toBe(2);
    expect(await rowsFor('address', unknown)).toBe(1);
    expect(await rowsFor('address', over)).toBe(3);
    // A body that is no address at all gets the same answer.
    expect(await ask(api, 'not json')).toStrictEqual({ status: 202, body: {} });
    expect(await ask(api, { email: 7 })).toStrictEqual({ status: 202, body: {} });
  },
);

withDatabase('records exactly 3 of 20 requests at once for one address', async () => {
  const address = `crowd-${randomUUID()}@example.test`;
  const answers = await Promise.all(
    Array.from(
      { length: 20 },
      async (_, i) => await ask(api, { email: `  ${address.toUpperCase()} ` }, `192.0.2.${i + 1}`),
    ),
  );
  expect(answers.every((answer) => answer.status === 202)).toBe(true);
  expect(await rowsFor('address', address)).toBe(3);
});

withDatabase('records exactly 10 of 20 requests at once from one caller', async () => {
  const caller = `203.0.113.${String(Math.floor(Math.random() * 200) + 20)}`;
  const answers = await Promise.all(
    Array.from(
      { length: 20 },
      async () => await ask(api, { email: `one-${randomUUID()}@example.test` }, caller),
    ),
  );
  expect(answers.every((answer) => answer.status === 202)).toBe(true);
  expect(await rowsFor('caller_digest', digest(caller))).toBe(10);
});
