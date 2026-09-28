// SPDX-License-Identifier: AGPL-3.0-only
//
// A surface route reads at most 1 MiB. One byte over, sized or streamed, is
// COMMAND_BODY_INVALID, recorded once, and nothing past the door runs.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { authorised, createApiFixture, tokenFor, type ApiFixture } from './fixture.ts';
import { ISSUER, SECRET } from './fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const MIB = 1_048_576;
const [CREATE, BOARD] = [pathOf('task.create'), pathOf('task.board')];
const padded = (bytes: number, value: object) => JSON.stringify(value).padEnd(bytes);
const COUNTS = ['audit_events', 'operations', 'records']
  .map((table) => `(select count(*)::int from public.${table} where business_id = $1) as ${table}`)
  .join(', ');
type Counts = Record<'refused' | 'audit_events' | 'operations' | 'records', number>;

async function send(api: Hono, path: string, body: string | ReadableStream, token: string) {
  const headers = { ...authorised(token), [DELEGATION_HEADER]: `probe-${randomUUID()}` };
  const init = { method: 'POST', headers, body, duplex: 'half' } as RequestInit;
  const response = await api.fetch(new Request(`http://api.test${path}`, init));
  return { status: response.status, text: await response.text() };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-1 request body limit', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let bravo: string;
  const token = { member: '', agent: '', bravo: '' };
  const THEIRS = `bravo-only-${randomUUID()}`;
  const counts = async (business: string) =>
    (
      await fixture.db.admin.execute<Counts>(
        `select (select count(*)::int from public.authentication_attempts where business_id = $1
                 and refusal_code = 'COMMAND_BODY_INVALID') as refused, ${COUNTS}`,
        [business],
      )
    )[0] as Counts;

  beforeAll(async () => {
    fixture = await createApiFixture('cq1_body');
    api = fixture.compose();
    token.member = await tokenFor(fixture.member.presented.subject);
    token.agent = await tokenFor(fixture.agent.subject);
    bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const writer = await enrol(fixture.db.app, bravo, 'bravo-writer');
    await fixture.db.app.withBusiness(bravo, async (tx) => await grantTo(tx, writer, 'write'));
    token.bravo = await tokenFor(writer.presented.subject);
    const task = JSON.stringify({ operationId: randomUUID(), fields: { title: THEIRS } });
    expect((await send(api, `/api/b/bravo${CREATE}`, task, token.bravo)).status).toBe(200);
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  it('CQ-1 body limit boundary: exactly 1 MiB is accepted and runs', async () => {
    const body = padded(MIB, { operationId: randomUUID(), fields: { title: 'at-the-limit' } });
    const before = await counts(fixture.business);
    expect((await send(api, `/api/b/alpha${CREATE}`, body, token.member)).status).toBe(200);
    const after = await counts(fixture.business);
    expect([after.records, after.refused]).toStrictEqual([before.records + 1, before.refused]);
  });

  for (const [who, door] of Object.entries({ member: '/api/b/alpha', agent: '/api/a/b/alpha' })) {
    for (const streamed of [false, true]) {
      it(`CQ-1 body limit boundary (${who}, streamed ${streamed}): one byte over is refused`, async () => {
        const text = padded(MIB + 1, { operationId: randomUUID(), fields: { title: 'over' } });
        const body = streamed ? new Blob([text]).stream() : text;
        const before = await counts(fixture.business);
        const answer = await send(api, `${door}${CREATE}`, body, token[who as 'member' | 'agent']);
        expect(`${answer.status} ${JSON.parse(answer.text).code}`).toBe('400 COMMAND_BODY_INVALID');
        const after = await counts(fixture.business);
        expect(after).toStrictEqual({ ...before, refused: before.refused + 1 });
      });
    }
  }

  it('CQ-1 isolation: another business is never read, listed, counted or changed', async () => {
    const before = await counts(bravo);
    const board = JSON.stringify({ board: null });
    const own = await send(api, `/api/b/alpha${BOARD}`, board, token.member);
    expect([own.status, own.text.includes(THEIRS)]).toStrictEqual([200, false]);
    for (const body of [board, padded(MIB + 1, {}), JSON.stringify({ fields: { title: 'x' } })]) {
      // eslint-disable-next-line no-await-in-loop -- one request at a time, counted after
      const across = await send(api, `/api/b/bravo${BOARD}`, body, token.member);
      expect([across.status === 200, across.text.includes(THEIRS)]).toStrictEqual([false, false]);
    }
    expect({ ...(await counts(bravo)), refused: before.refused }).toStrictEqual(before);
  });

  it('CQ-1 token canary: a planted token and secret reach no log, refusal or stored row', async () => {
    const canary = `cq1-canary-${randomUUID()}`;
    const claims = { sub: fixture.member.presented.subject, aud: 'anon', iss: ISSUER, canary };
    const planted = await sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    const lines: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...parts) => lines.push(...parts)),
    );
    const secretish = { secretish: `SUPABASE_JWT_SECRET=${canary}` };
    const answers = await Promise.all([
      send(api, `/api/b/alpha${CREATE}`, '{}', planted),
      send(api, `/api/b/alpha${CREATE}`, padded(MIB + 1, secretish), token.member),
      send(api, `/api/b/alpha${CREATE}`, JSON.stringify(secretish), token.member),
    ]).finally(() => spies.forEach((spy) => spy.mockRestore()));
    const stored = await fixture.db.admin.execute(
      `select a::text from public.authentication_attempts a union all
       select e::text from public.audit_events e union all select o::text from public.operations o`,
    );
    const seen = JSON.stringify([answers, lines.map(String), stored]);
    for (const value of [canary, planted, token.member, SECRET]) expect(seen).not.toContain(value);
  });
});
