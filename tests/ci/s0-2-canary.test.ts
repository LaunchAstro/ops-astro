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
import { sign } from 'hono/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { createAlerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { COMMAND_SURFACE, PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';
import { times } from './s0-2-plain.ts';

const CANARY_SECRET = 'canary-S02CANARY-4e8a1c-alert-secret';
const RECORD_CONTENT = 'Private note: client Juniper Vale owes 4,210';
const SECRET = 'a-local-test-secret-for-the-canary-case';
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
    secret: SECRET,
    issuer: ISSUER,
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
  return await sign(claims, SECRET, 'HS256');
}

describe('S0-2 canary', () => {
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
