// SPDX-License-Identifier: AGPL-3.0-only
// S0-2 canary: a planted secret and planted record content never reach the
// error sink, the log, the response or an alert.
//
// The served composition (`composeApi`) with the sink as a fake transport. A
// read throws a fault whose message carries both plants, under a bearer whose
// subject is the secret and a body carrying the content; the same subject is
// then refused until the detector raises. Every
// place the fault could travel is read back: the events the sink
// was handed, what the server wrote to the console, and the response body.
// Nothing here writes an audit payload; the alerts path holds no connection.

import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { faultCode } from '../../apps/api/alerts/sink.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { bearer, READ_PATH, served } from './s0-2-canary.fixture.ts';

afterEach(() => vi.restoreAllMocks());

/** A driver error the caller made itself: no database answered. */
const made = (code: string) => new postgres.PostgresError({ code, message: 'm' } as never);

describe('S0-2 canary', () => {
  canaryCasesSolNarrow();
  canaryCases1();
  canaryCases2();
  canaryCases3();
  canaryCases4();
});

function canaryCasesSolNarrow() {
  it('subclass and proxy codes stay within the fixed list', () => {
    class Forged extends postgres.PostgresError {}
    for (const code of ['K7QXZ', 'P0001', '22p02', '22P02 ', '💥💥💥💥💥']) {
      const fault = new Forged({ code, message: 'private text' } as never);
      expect(faultCode(fault), code).not.toBe(code);
      expect(faultCode(new Proxy(fault, {})), code).not.toBe(code);
    }
    expect(faultCode(new Forged({ code: '23505', message: 'private text' } as never))).toBe(
      '23505',
    );
  });

  it('a proxy fault cannot make the API error path throw its planted message', async () => {
    const plant = 'SOL_PROXY_PLANT';
    const hostile = new Proxy(
      new postgres.PostgresError({ code: 'K7QXZ', message: plant } as never),
      { getPrototypeOf: () => { throw new Error(plant); } },
    );
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(' '));
    });
    const { app, alerts, events } = served(() => Promise.reject(hostile));
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer('person-one')}`,
        },
        body: '{}',
      }),
    );
    await alerts.settled();
    expect(response.status).toBe(503);
    expect(logged).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(`${logged.join('\n')}\n${JSON.stringify(events)}\n${await response.text()}`).not.toContain(plant);
  });
}

function canaryCases1() {
  it('a manufactured database error cannot log a planted code', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    // No database ran: the caller manufactured an instance of the driver's public class.
    const planted = new postgres.PostgresError({ code: 'K7QXZ', message: 'a fault' } as never);
    const { app, events, alerts } = served(() => Promise.reject(planted));
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer('person-one')}`,
        },
        body: '{}',
      }),
    );
    await alerts.settled();
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    const exposures = {
      'API log': logged.join('\n'),
      'sink event': JSON.stringify(events),
      response: await response.text(),
    };
    for (const [where, seen] of Object.entries(exposures)) {
      expect(seen.includes('K7QXZ'), `the planted code in ${where}`).toBe(false);
    }
  });

  it('S0-2 canary: a database code is logged only from the listed SQLSTATEs, whoever made the error', () => {
    expect(faultCode(made('22P02'))).toBe('22P02');
    expect(faultCode(made('40001'))).toBe('40001');
    // Five characters of anything are a channel into the log: refused.
    for (const code of ['K7QXZ', 'P0001', 'ZZZZZ', '22p02', '22P02 ']) {
      expect(faultCode(made(code)), code).toBe('unknown');
    }
    // A listed code on anything but the driver's error is not a database code.
    expect(faultCode(Object.assign(new Error('m'), { code: '22P02' }))).toBe('Error');
  });
}

/** One fault through the served API: 503, one sink event, the bounded log line, and no plant anywhere. */
async function check(fault: Error, logs: string): Promise<void> {
  const logged: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(
    (...parts: unknown[]) => void logged.push(parts.join(' ')),
  );
  const { app, events, alerts } = served(() => Promise.reject(fault));
  const response = await app.fetch(
    new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await bearer('person-one')}`,
      },
      body: '{}',
    }),
  );
  await alerts.settled();
  vi.restoreAllMocks();
  expect(response.status).toBe(503);
  expect(events).toHaveLength(1);
  expect(logged.join('\n').includes(logs), 'the bounded log line').toBe(true);
  for (const [where, seen] of [
    ['log', logged.join('\n')],
    ['sink', JSON.stringify(events)],
    ['response', await response.text()],
  ]) {
    expect(/QZCAN/u.test(seen ?? ''), `a plant in the ${where}`).toBe(false);
  }
}

function canaryCases2() {
  it('a canary in every field of a fault (name, code, message, stack, constraint, detail, cause) reaches no log, sink or response', async () => {
    const PLANT = 'QZCANARYQZ';
    const planted = Object.assign(new Error(`${PLANT} in the message`), {
      name: PLANT,
      code: 'QZCAN',
      constraint_name: `${PLANT}_constraint`,
      detail: PLANT,
      cause: new Error(PLANT),
    });
    planted.stack = `${PLANT}: x\n    at ${PLANT} (${process.cwd()}/apps/api/app.ts:1:1)\n    at /${PLANT}.ts:2:2`;
    const genuine = new postgres.PostgresError({
      code: '22P02',
      message: `${PLANT} value`,
    } as never);
    await check(planted, 'api: unhandled fault unknown (reference');
    await check(genuine, 'api: unhandled fault 22P02 (reference');
  });
}

function canaryCases3() {
  it('a five-character planted fault code never reaches the API log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const planted = Object.assign(new Error('a fault'), { code: 'K7QXZ' });
    const { app, events, alerts } = served(() => Promise.reject(planted));
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer('person-one')}`,
        },
        body: '{}',
      }),
    );
    await alerts.settled();
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(logged.join('\n').includes('K7QXZ'), 'the planted secret').toBe(false);
  });
}

function canaryCases4() {
  it('a fault whose code and constraint carry planted words logs as unknown, never the plant', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const planted = Object.assign(new Error('x'), {
      code: 'PLANTEDCANARYCODE',
      constraint_name: 'planted_canary_constraint',
    });
    const { app, alerts } = served(() => Promise.reject(planted));
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer('person-one')}`,
        },
        body: '{}',
      }),
    );
    await alerts.settled();
    expect(response.status).toBe(503);
    const log = logged.join('\n');
    expect(log.includes('api: unhandled fault Error (reference'), 'the standard class').toBe(true);
    expect(/planted|PLANTED/u.test(log), 'a planted word').toBe(false);
  });
}
