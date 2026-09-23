// SPDX-License-Identifier: AGPL-3.0-only
//
// A body that is not a JSON object, on both prefixes: refused, and recorded.
//
// The boundary refused it `COMMAND_BODY_INVALID` and kept nothing, so the one
// refusal that arrives before a domain actor exists was the one refusal with
// no trail (root ruling 4). By the time the body is read the bearer has been
// verified and the business key resolved by the server, which is everything
// the authentication-attempt owner records: the business, the owner, the
// provider and the subject's digest. So the refusal is written there, once,
// with its real reason, and never as an `audit_events` row with an actor
// somebody made up. The body and the bearer are stored nowhere.
//
// What stays as it was: an unknown login, an expired bearer and an unknown
// business answer exactly as before and write nothing, because there is no
// verified subject, or no business, to record the attempt against.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';
import { DELEGATION_HEADER } from '../../apps/api/app.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The malformed bodies, as the bytes a client sent. */
const BODIES: readonly (readonly [string, string])[] = [
  ['not JSON at all', 'this is not json {'],
  ['an array', '[{"fields":{"title":"x"}}]'],
  ['a string', '"task.create"'],
  ['a number', '42'],
  ['null', 'null'],
];

const PREFIXES = [
  { prefix: 'person', path: `/api/b/${BUSINESS_KEY}`, owner: 'person_login' },
  { prefix: 'agent', path: `/api/a/b/${BUSINESS_KEY}`, owner: 'agent_login' },
] as const;

const OPERATIONS = ['task.create', 'task.queue'] as const;

interface Raw {
  readonly status: number;
  readonly text: string;
}

async function send(
  api: Hono,
  path: string,
  bytes: string,
  headers: Record<string, string>,
): Promise<Raw> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bytes,
    }),
  );
  return { status: response.status, text: await response.text() };
}

const digestOf = (subject: string): string =>
  createHash('sha256').update(`supabase\u0000${subject}`, 'utf8').digest('hex');

describe.skipIf(serverUrl === undefined)('a non-object body is an admission refusal', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let memberToken: string;
  let agentToken: string;
  let stranger: Member;
  let strangerToken: string;
  let bravo: string;

  const counts = async (business: string) => {
    const rows = await fixture.db.admin.execute<Record<string, number>>(
      `select (select count(*)::int from public.authentication_attempts where business_id = $1) as attempts,
              (select count(*)::int from public.audit_events where business_id = $1) as audit,
              (select count(*)::int from public.operations where business_id = $1) as operations,
              (select count(*)::int from public.records where business_id = $1) as records,
              (select coalesce(max(xmin::text::bigint), 0)::bigint::text from public.records where business_id = $1) as records_xmin`,
      [business],
    );
    return rows[0] as Record<string, number>;
  };

  const latestAttempt = async (business: string) => {
    const rows = await fixture.db.admin.execute<Record<string, unknown>>(
      `select * from public.authentication_attempts where business_id = $1 order by at desc, id limit 1`,
      [business],
    );
    return rows[0];
  };

  beforeAll(async () => {
    fixture = await createApiFixture('boundary_body');
    api = fixture.compose();
    memberToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    // A second business, so a refusal in alpha can be shown to write nothing there.
    bravo = await insertBusiness(fixture.db.app, 'bravo');
    // A verified subject with a login in bravo and none in alpha.
    stranger = await enrol(fixture.db.app, bravo, 'stranger');
    strangerToken = await tokenFor(stranger.presented.subject);
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  for (const { prefix, path, owner } of PREFIXES) {
    for (const operation of OPERATIONS) {
      for (const [label, bytes] of BODIES) {
        it(`${prefix} ${operation}: ${label} is refused and recorded once, with nothing else changed`, async () => {
          const token = prefix === 'person' ? memberToken : agentToken;
          const subject =
            prefix === 'person' ? fixture.member.presented.subject : fixture.agent.subject;
          const headers = {
            ...authorised(token),
            ...(prefix === 'agent' ? { [DELEGATION_HEADER]: `probe-${randomUUID()}` } : {}),
          };
          const before = await counts(fixture.business);
          const bravoBefore = await counts(bravo);

          const answer = await send(api, `${path}${pathOf(operation)}`, bytes, headers);

          expect(answer.status).toBe(400);
          const body = JSON.parse(answer.text) as Record<string, unknown>;
          expect(body['refused']).toBe(true);
          expect(body['code']).toBe('COMMAND_BODY_INVALID');
          expect(body['names']).toStrictEqual([]);

          const after = await counts(fixture.business);
          expect(after['attempts']).toBe(Number(before['attempts']) + 1);
          // No domain change and no invented actor: nothing in the audit chain,
          // the register or the records.
          expect(after['audit']).toBe(before['audit']);
          expect(after['operations']).toBe(before['operations']);
          expect(after['records']).toBe(before['records']);
          expect(after['records_xmin']).toBe(before['records_xmin']);
          expect(await counts(bravo)).toStrictEqual(bravoBefore);

          const row = await latestAttempt(fixture.business);
          expect(row).toMatchObject({
            owner,
            provider: 'supabase',
            subject_digest: digestOf(subject),
            outcome: 'refused',
            refusal_code: 'COMMAND_BODY_INVALID',
            login_id: null,
            actor_id: null,
            person_id: null,
          });
          // Neither the body, the bearer nor the delegation credential is kept.
          const stored = JSON.stringify(row);
          expect(stored).not.toContain(subject);
          expect(stored).not.toContain(token);
          expect(stored).not.toContain('probe-');
          if (bytes.length > 4) expect(stored).not.toContain(bytes);
        });
      }
    }
  }

  it('answers a member and a stranger to the business with the same bytes', async () => {
    const path = `/api/b/${BUSINESS_KEY}${pathOf('task.create')}`;
    const bravoBefore = await counts(bravo);
    const member = await send(api, path, '[]', authorised(memberToken));
    const outsider = await send(api, path, '[]', authorised(strangerToken));
    expect(outsider).toStrictEqual(member);
    // The stranger's attempt is alpha's to keep, as its unmapped login would be;
    // bravo, where the stranger does have a login, is not told.
    expect(await counts(bravo)).toStrictEqual(bravoBefore);
    expect(await latestAttempt(fixture.business)).toMatchObject({
      subject_digest: digestOf(stranger.presented.subject),
      refusal_code: 'COMMAND_BODY_INVALID',
    });
  });

  it('keeps unknown login, expired bearer and unknown business as they were, writing nothing', async () => {
    const expired = await tokenFor(fixture.member.presented.subject, { expiresIn: -60 });
    const expiredAgent = await tokenFor(fixture.agent.subject, { expiresIn: -60 });
    const before = await counts(fixture.business);
    const bravoBefore = await counts(bravo);
    const create = pathOf('task.create');

    const unknown = await send(api, `/api/b/${BUSINESS_KEY}${create}`, '[]', {});
    expect(JSON.parse(unknown.text)['code']).toBe('AUTH_UNKNOWN_LOGIN');
    const unknownAgent = await send(api, `/api/a/b/${BUSINESS_KEY}${create}`, '[]', {});
    expect(JSON.parse(unknownAgent.text)['code']).toBe('AUTH_UNKNOWN_LOGIN');

    const ended = await send(api, `/api/b/${BUSINESS_KEY}${create}`, '[]', authorised(expired));
    expect(JSON.parse(ended.text)['code']).toBe('AUTH_SESSION_EXPIRED');
    // An expired bearer is the re-login answer on the agent prefix too,
    // before the key or the body is looked at (Sol 6 AUTHORITY-1).
    const endedAgent = await send(
      api,
      `/api/a/b/${BUSINESS_KEY}${create}`,
      '[]',
      authorised(expiredAgent),
    );
    expect(JSON.parse(endedAgent.text)['code']).toBe('AUTH_SESSION_EXPIRED');

    const nowhere = await send(
      api,
      `/api/b/no-such-business${create}`,
      '[]',
      authorised(memberToken),
    );
    // A malformed body is refused as one whether the key names a business or
    // not, so the answer cannot tell the two apart (Sol 6 SURFACE-1); nothing
    // is recorded, because no business resolved.
    expect(JSON.parse(nowhere.text)['code']).toBe('COMMAND_BODY_INVALID');
    const nowhereAgent = await send(
      api,
      `/api/a/b/no-such-business${create}`,
      '[]',
      authorised(agentToken),
    );
    expect(JSON.parse(nowhereAgent.text)['code']).toBe('COMMAND_BODY_INVALID');

    expect(await counts(fixture.business)).toStrictEqual(before);
    expect(await counts(bravo)).toStrictEqual(bravoBefore);
  });

  it('still serves a well-formed body afterwards', async () => {
    const created = await send(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf('task.create')}`,
      JSON.stringify({ operationId: randomUUID(), fields: { title: 'after the refusals' } }),
      authorised(memberToken),
    );
    expect(created.status, created.text).toBe(200);
  });
});
