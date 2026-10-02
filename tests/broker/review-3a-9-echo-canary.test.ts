// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, n=9: aw-01-broker.test.ts's canary case says
// the planted key reaches "no row, audit payload or answer", but it never reads
// an answer and no broker case runs the provider's echo_credential mode. This
// suite does: a priced call through callModel against a provider that echoes
// the credential back, plainly (the replay provider's own echo_credential mode)
// and JSON-escaped (a loopback stand-in that echoes the same answer with `\/`
// for a slash or `c` for the key's first character). The answer text the
// broker returns, and every row of every public table, must hold no key.
//
// Expected red on 8cbd0e422 (batch 3a before its fix squash) for the escaped spellings because of n=8: custody
// redacts the raw bytes and the broker JSON-parses them afterwards.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { REPLAY_MODEL_WINDOW } from '../../packages/core-connectors/src/index.ts';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import { plantedKey } from '../custody/custody-world.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { noDatabase, useBrokerWorld, s, world, broker, call } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('review3a9');

// The escaped stand-in's own key: starts with 'c' and holds a '/', so both spellings exist.
const slashKey = `${plantedKey()}/${randomBytes(9).toString('hex')}`;
let spelling: 'slash' | 'u0063' = 'slash';
let echoServer: Server;
let echoCustody: Custody;

/** The replay provider's echo_credential answer, with the authorization JSON-escaped. */
const escaped = (authorization: string): string => {
  const text = `you sent ${authorization}`;
  const body =
    spelling === 'slash' ? text.replaceAll('/', '\\/') : text.replace(/(?<=Bearer )c/u, '\\u0063');
  return `{"text":"${body}","model":"${REPLAY_MODEL_WINDOW.model}","usage":{"input":1,"output":1}}`;
};

beforeAll(async () => {
  if (noDatabase) return;
  echoServer = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(escaped(request.headers['authorization'] ?? ''));
    });
  });
  await new Promise<void>((done) => {
    echoServer.listen(0, '127.0.0.1', done);
  });
  const port = (echoServer.address() as AddressInfo).port;
  echoCustody = await startCustody({
    credentialsFile: world.writeCredentials([
      {
        ref: 'replay_key',
        kind: 'api_key',
        account: 'replay-account-1',
        destination: 'replay',
        header: 'authorization',
        value: slashKey,
      },
    ]),
    destinations: [{ key: 'replay', origin: `http://127.0.0.1:${String(port)}` }],
  });
}, 60_000);

afterAll(async () => {
  await echoCustody?.stop();
  await new Promise<void>((done) => {
    if (echoServer === undefined) {
      done();
      return;
    }
    echoServer.close(() => {
      done();
    });
  });
});

/** Every row of every public table, as text. */
const everyRow = async (): Promise<string> => {
  const rows = await s.db.admin.execute<{ dump: string }>(
    `select coalesce(string_agg(query_to_xml(format('select * from %I.%I', table_schema, table_name),
              true, false, '')::text, ' '), '') as dump
       from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return rows[0]?.dump ?? '';
};

it('REVIEW-3A-9: a provider echoing the key plainly, the answer text and every row hold no key', async () => {
  const work = await liveWork(s, 'echo plain', 2_000);
  world.provider.mode('echo_credential');
  const result = await call(work);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  // The provider did get the key: the search below is not vacuous.
  expect(world.provider.seen.at(-1)?.authorization).toBe(`Bearer ${world.canary}`);
  if (result.ok) expect(result.text).not.toContain(world.canary);
  expect(await everyRow()).not.toContain(world.canary);
});

/** One escaped-echo case: the provider echoes the key in the `which` spelling. */
const escapedEchoCase = (name: string, which: typeof spelling) => async (): Promise<void> => {
  spelling = which;
  const work = await liveWork(s, `echo ${which}`, 2_000);
  const result = await call(work, {}, { ...broker, custody: echoCustody });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    expect(result.text, `answer text holds the key (${name})`).not.toContain(slashKey);
  }
  expect(await everyRow()).not.toContain(slashKey);
};

for (const [name, which] of [
  ['slash escaped as \\/', 'slash'],
  ['first character escaped as \\u0063', 'u0063'],
] as const) {
  it(
    `REVIEW-3A-9: a provider echoing the key JSON-escaped (${name}), the answer text and every row hold no key`,
    escapedEchoCase(name, which),
  );
}
