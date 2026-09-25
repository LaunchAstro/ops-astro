// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol 6 SURFACE-1 and AUTHORITY-1: a business key that exists but that the
// caller cannot reach, and a key nobody holds, must answer in the same raw
// bytes on both prefixes, for a valid body and a malformed one. An expired
// bearer is the re-login answer before the key or the body is looked at, and
// an admission attempt is recorded only in a business that resolved.
// AUTHORITY-4's boundary half: a non-string `operationId` on the agent prefix
// is not turned into a valid one.
//
// Through `composeApi`, the server's own wiring, over a throwaway database.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, createApiFixture, tokenFor, type ApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The key of a business that exists and that nobody in the fixture belongs to. */
const FOREIGN = 'bravo';
/** A key no business holds. */
const FABRICATED = 'zulu-not-a-business';

interface Raw {
  readonly status: number;
  readonly text: string;
}

async function raw(api: Hono, path: string, body: string, token: string): Promise<Raw> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorised(token) },
      body,
    }),
  );
  return { status: response.status, text: await response.text() };
}

const VALID = JSON.stringify({ operationId: 'enumeration-probe-1' });
const MALFORMED = '[1]';
const PREFIXES = [
  ['person', (key: string) => `/api/b/${key}/task/queue`],
  ['agent', (key: string) => `/api/a/b/${key}/task/queue`],
] as const;

describe.skipIf(serverUrl === undefined)('admission does not tell a business key apart', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let foreign: string;
  let memberToken: string;
  let agentToken: string;
  let expiredToken: string;

  async function attempts(businessId: string): Promise<number> {
    const rows = await fixture.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from public.authentication_attempts where business_id = $1',
      [businessId],
    );
    return Number(rows[0]?.n);
  }

  beforeAll(async () => {
    fixture = await createApiFixture('aen');
    foreign = String(await insertBusiness(fixture.db.app, FOREIGN));
    api = fixture.compose();
    memberToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    expiredToken = await tokenFor(fixture.member.presented.subject, { expiresIn: -60 });
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  for (const [prefix, path] of PREFIXES) {
    for (const [shape, body] of [
      ['valid', VALID],
      ['malformed', MALFORMED],
    ] as const) {
      for (const [who, token] of [
        ['a person', () => memberToken],
        ['an agent', () => agentToken],
      ] as const) {
        it(`${prefix} prefix, ${shape} body, ${who}: a foreign key and a fabricated one answer the same bytes`, async () => {
          const existing = await raw(api, path(FOREIGN), body, token());
          const missing = await raw(api, path(FABRICATED), body, token());
          expect(missing).toStrictEqual(existing);
          expect(existing.status).toBeGreaterThanOrEqual(400);
        });
      }

      it(`${prefix} prefix, ${shape} body: an expired bearer is the re-login answer for any key`, async () => {
        const answers = await Promise.all(
          ['alpha', FOREIGN, FABRICATED].map(
            async (key) => await raw(api, path(key), body, expiredToken),
          ),
        );
        for (const answer of answers) {
          expect(answer.status).toBe(401);
          expect(JSON.parse(answer.text)).toStrictEqual({
            refused: true,
            code: 'AUTH_SESSION_EXPIRED',
            names: [],
            fixes: [
              'The session has expired. Sign in again to continue.',
              'Nothing was changed by this call.',
            ],
          });
        }
      });
    }
  }

  it('records a malformed-body attempt in the business that resolved, and nowhere else', async () => {
    const alphaBefore = await attempts(fixture.business);
    const foreignBefore = await attempts(foreign);
    await raw(api, `/api/b/${FOREIGN}/task/queue`, MALFORMED, memberToken);
    await raw(api, `/api/b/${FABRICATED}/task/queue`, MALFORMED, memberToken);
    expect(await attempts(foreign)).toBe(foreignBefore + 1);
    expect(await attempts(fixture.business)).toBe(alphaBefore);
  });

  for (const [label, operationId] of [
    ['a number', 12_345_678],
    ['an array', ['12345678']],
    ['null', null],
  ] as const) {
    it(`AUTHORITY-4: ${label} as the agent's operationId is OPERATION_ID_REQUIRED, with no operation row`, async () => {
      const answer = await raw(
        api,
        '/api/a/b/alpha/task/queue',
        JSON.stringify({ operationId }),
        agentToken,
      );
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toMatchObject({ code: 'OPERATION_ID_REQUIRED' });
      const rows = await fixture.db.admin.execute<{ n: string }>(
        `select count(*)::text as n from public.operations
          where business_id = $1 and operation_id = '12345678'`,
        [fixture.business],
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it('AUTHORITY-4: a string operationId still reaches the queue', async () => {
    const answer = await raw(
      api,
      '/api/a/b/alpha/task/queue',
      JSON.stringify({ operationId: `queue-${randomUUID()}` }),
      agentToken,
    );
    expect(answer.status).toBe(200);
  });
});
