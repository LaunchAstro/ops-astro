// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T enrolment route: what `POST /api/enrol` refuses before an accept is
// tried, and what a fault answers. A body past 2 KiB is 413, a body that is
// not one JSON object holding the token and password as strings is 400, and
// neither reaches the deployment's businesses, the database or the broker. A
// fault while accepting is 503 `ENROL_FAULT` and names nothing of it.

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { ENROL_API_PATH, mountEnrolment } from '../../apps/api/enrolment.ts';

/** A token of the shape a send mints: 43 base64url characters. */
const TOKEN = 'A'.repeat(43);
const PASSWORD = 'a long enough password';

/** The route over a database and broker that throw if anything reaches them. */
function route(reached: string[]): Hono {
  const app = new Hono();
  const database = {
    withBusiness: async () => {
      reached.push('database');
      throw new Error('a planted fault naming business 7f3c');
    },
  } as unknown as Database;
  mountEnrolment(app, database, {
    businesses: async () => {
      reached.push('businesses');
      return await Promise.resolve(['7f3c']);
    },
    broker: {} as Broker,
  });
  return app;
}

const post = async (app: Hono, body: string): Promise<Response> =>
  await app.fetch(
    new Request(`http://api.test${ENROL_API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );

it('C39-T enrolment route: a body over 2 KiB is refused 413 ENROL_TOO_LARGE, reaching nothing', async () => {
  const reached: string[] = [];
  const body = JSON.stringify({ token: TOKEN, password: 'p'.repeat(2048) });
  const response = await post(route(reached), body);
  expect(response.status).toBe(413);
  expect(await response.json()).toStrictEqual({ code: 'ENROL_TOO_LARGE' });
  expect(reached).toStrictEqual([]);
});

it('C39-T enrolment route: a body that is not one object holding the token and password as strings is 400 ENROL_MALFORMED, reaching nothing', async () => {
  const reached: string[] = [];
  const app = route(reached);
  const bodies = [
    'not json',
    '[]',
    'null',
    JSON.stringify({ token: TOKEN }),
    JSON.stringify({ password: PASSWORD }),
    JSON.stringify({ token: 1, password: PASSWORD }),
    JSON.stringify({ token: TOKEN, password: ['p'] }),
  ];
  for (const body of bodies) {
    // oxlint-disable-next-line no-await-in-loop
    const response = await post(app, body);
    expect(response.status, body).toBe(400);
    // oxlint-disable-next-line no-await-in-loop
    expect(await response.json(), body).toStrictEqual({ code: 'ENROL_MALFORMED' });
  }
  expect(reached).toStrictEqual([]);
});

it('C39-T enrolment route: a fault while accepting is 503 ENROL_FAULT and the answer names nothing of it', async () => {
  const reached: string[] = [];
  const response = await post(route(reached), JSON.stringify({ token: TOKEN, password: PASSWORD }));
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(JSON.parse(text)).toStrictEqual({ code: 'ENROL_FAULT' });
  expect(text).not.toContain('7f3c');
  expect(reached).toStrictEqual(['businesses', 'database']);
});
