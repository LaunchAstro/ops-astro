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
import { composeApi } from '../../apps/api/server.ts';
import { createAlerts, faultCode, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { COMMAND_SURFACE, PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { times } from './s0-2-plain.ts';

const CANARY_SECRET = 'canary-S02CANARY-4e8a1c-alert-secret';
const RECORD_CONTENT = 'Private note: client Juniper Vale owes 4,210';
const ISSUER = 'http://127.0.0.1:54391';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const READ = COMMAND_SURFACE.find((declaration) => declaration.kind === 'read');
if (READ === undefined) throw new Error('the surface declares no read');
const READ_PATH = pathOf(READ.name);

afterEach(() => vi.restoreAllMocks());

function served(executeRead: () => Promise<never>) {
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    send: (e) => Promise.resolve(void events.push(e)),
    where: 'staging',
    root: process.cwd(),
  });
  const admin = {
    execute: (_sql: string, parameters: readonly unknown[] = []) =>
      Promise.resolve(parameters[0] === 'alpha' ? [{ id: ALPHA }] : []),
  } as unknown as AdminConnection;
  const { app } = composeApi({
    database: {} as Database,
    admin,
    signIn: testSignIn(ISSUER),
    keys: runtimeKeys({}),
    executeRead: executeRead as never,
    alerts,
  });
  return { app, events, alerts };
}

async function bearer(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
  };
  return await signBearer(claims);
}

/** A driver error the caller made itself: no database answered. */
const made = (code: string) => new postgres.PostgresError({ code, message: 'm' } as never);

describe('S0-2 canary', () => {
  it('Sol proof, criterion 4: a manufactured database error cannot log a planted code', async () => {
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
    const check = async (fault: Error, logs: string): Promise<void> => {
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
    };
    await check(planted, 'api: unhandled fault unknown (reference');
    await check(genuine, 'api: unhandled fault 22P02 (reference');
  });

  it('Sol proof, criterion 4: a five-character planted fault code never reaches the API log', async () => {
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

  it('Sol proof, criterion 4: an identifier-shaped planted error name never reaches the API log', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const planted = new Error('a fault');
    planted.name = 'CanarySecretLettersOnly';
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
    expect(logged.join('\n').includes('CanarySecretLettersOnly'), 'the planted secret').toBe(false);
  });

  it('a fault carrying a planted secret and record content reaches the sink without either', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...parts: unknown[]) => void logged.push(parts.join(' ')),
    );
    const { app, events, alerts } = served(() =>
      Promise.reject(new Error(`${CANARY_SECRET} ${RECORD_CONTENT}`)),
    );
    const response = await app.fetch(
      new Request(`http://api.test${PREFIX.person}alpha${READ_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await bearer(CANARY_SECRET)}`,
        },
        body: JSON.stringify({ note: RECORD_CONTENT, key: CANARY_SECRET }),
      }),
    );
    await alerts.settled();
    const answered = await response.text();
    expect(response.status).toBe(503);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('error');
    for (const place of [JSON.stringify(events), logged.join('\n'), answered]) {
      // Booleans, so a failure message never prints what it found.
      expect(place.includes('S02CANARY'), 'the planted secret').toBe(false);
      expect(place.includes('Juniper'), 'the planted content').toBe(false);
    }
  });

  it('refusals of a subject that is the planted secret raise an alert that does not carry it', async () => {
    const { app, events, alerts } = served(() => Promise.reject(new Error('unused')));
    await times(10, async () => {
      const response = await app.fetch(
        new Request(`http://api.test${PREFIX.person}nobody-${CANARY_SECRET}${READ_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await bearer(CANARY_SECRET)}`,
          },
          body: JSON.stringify({ note: RECORD_CONTENT }),
        }),
      );
      expect(response.status).toBe(403);
    });
    await alerts.settled();
    expect(events.map((e) => e.tags['alert'])).toEqual(['cross-scope-burst']);
    expect(JSON.stringify(events).includes('S02CANARY'), 'the planted secret').toBe(false);
    expect(JSON.stringify(events).includes('Juniper'), 'the planted content').toBe(false);
  });
});
