// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB: bodies the stores cannot hold as sent (final review round 1,
// #11, #12 and #18).
//
// #11. `JSON.parse` reads 1e400 as Infinity. The payload digest refuses a
// non-finite number, and it is taken before anything else on every entry, so
// the attempt ended in a 503 with nothing recorded, and the person path's
// `failed` fallback took the same digest and threw again. The door now refuses
// such a body `COMMAND_BODY_INVALID` and records it as every other malformed
// body is recorded.
//
// #12 and #18. A jsonb string cannot hold U+0000 or an unpaired surrogate.
// A refusal that keeps what the caller attempted (a system-owned field, a
// spoofed source) or names a key the caller sent faulted at the insert, so the
// owed refusal became a 503 and the refused row was lost; the agent and read
// paths recorded nothing. The refusal now stands, with its audit row, and the
// stored copy spells the unstorable code points as JSON escapes.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { verifyAuditChain } from '../../packages/core-records/src/commands/audit.ts';
import {
  DELEGATION_HEADER,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE = String.fromCodePoint(0xd800);

interface Raw {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Prefix = 'person' | 'agent';

describe.skipIf(serverUrl === undefined)('FR1-JSONB: unstorable bodies', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let memberToken: string;
  let agentToken: string;
  let task: { id: string; revision: number };

  /** The bytes as a client sent them, so 1e400 survives to the server. */
  const send = async (prefix: Prefix, name: CommandName, bytes: string): Promise<Raw> => {
    const base = prefix === 'person' ? `/api/b/${BUSINESS_KEY}` : `/api/a/b/${BUSINESS_KEY}`;
    const headers =
      prefix === 'person'
        ? authorised(memberToken)
        : { ...authorised(agentToken), [DELEGATION_HEADER]: `probe-${randomUUID()}` };
    const response = await api.fetch(
      new Request(`http://api.test${base}${pathOf(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: bytes,
      }),
    );
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  };

  const counts = async () => {
    const rows = await fixture.db.admin.execute<Record<string, number>>(
      `select (select count(*)::int from public.authentication_attempts where business_id = $1) as attempts,
              (select count(*)::int from public.audit_events where business_id = $1) as audit,
              (select count(*)::int from public.audit_events where business_id = $1 and outcome = 'failed') as failed,
              (select count(*)::int from public.operations where business_id = $1) as operations`,
      [fixture.business],
    );
    return rows[0] as Record<string, number>;
  };

  const lastAudit = async () => {
    const rows = await fixture.db.admin.execute<Record<string, unknown>>(
      `select command, outcome, refusal_code, attempted from public.audit_events
        where business_id = $1 order by seq desc limit 1`,
      [fixture.business],
    );
    return rows[0];
  };

  const refresh = async () => {
    const rows = await fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [fixture.business, task.id],
    );
    task.revision = Number(rows[0]?.revision);
  };

  beforeAll(async () => {
    fixture = await createApiFixture('fr1_jsonb');
    api = fixture.compose();
    memberToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, fixture.member, 'manage', WHOLE_BUSINESS, false, 'task');
    });
    const made = await send(
      'person',
      'task.create',
      JSON.stringify({ operationId: randomUUID(), fields: { title: 'fr1 jsonb task' } }),
    );
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    task = { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  }, 60_000);

  afterAll(async () => await fixture?.drop());

  describe('#11: a number that overflows to Infinity', () => {
    const cases: readonly (readonly [Prefix, CommandName, () => string])[] = [
      [
        'person',
        'task.create',
        () => `{"operationId":"${randomUUID()}","fields":{"title":"x"},"n":1e400}`,
      ],
      [
        'person',
        'task.create',
        () => `{"operationId":"${randomUUID()}","fields":{"title":"x","estimate":1e400}}`,
      ],
      ['agent', 'task.queue', () => `{"n":1e400}`],
      ['person', 'task.read', () => `{"recordId":"${task.id}","x":1e400}`],
      ['agent', 'task.create', () => `{"operationId":"${randomUUID()}","n":-1e400}`],
    ];
    for (const [prefix, name, bytes] of cases) {
      it(`${prefix} ${name}: refused COMMAND_BODY_INVALID and recorded once`, async () => {
        const before = await counts();
        const answer = await send(prefix, name, bytes());
        expect(answer.status, JSON.stringify(answer.body)).toBe(400);
        expect(answer.body).toMatchObject({ refused: true, code: 'COMMAND_BODY_INVALID' });
        const after = await counts();
        expect(after['attempts']).toBe(Number(before['attempts']) + 1);
        expect(after['audit']).toBe(before['audit']);
        expect(after['operations']).toBe(before['operations']);
      });
    }
  });

  describe('#12 and #18: NUL and lone surrogates in what a refusal keeps', () => {
    const refusedOnce = async (
      prefix: Prefix,
      name: CommandName,
      body: Record<string, unknown>,
      expected: { readonly status: number; readonly code: string },
    ) => {
      const before = await counts();
      const answer = await send(prefix, name, JSON.stringify(body));
      expect(answer.status, JSON.stringify(answer.body)).toBe(expected.status);
      expect(answer.body).toMatchObject({ refused: true, code: expected.code });
      const after = await counts();
      expect(after['audit']).toBe(Number(before['audit']) + 1);
      expect(after['failed']).toBe(before['failed']);
      const audit = await lastAudit();
      expect(audit).toMatchObject({
        command: name,
        outcome: 'refused',
        refusal_code: expected.code,
      });
      return { answer, audit, before, after };
    };

    for (const [label, value] of [
      ['NUL', NUL],
      ['a NUL inside', `a${NUL}b`],
      ['a lone surrogate', LONE],
    ] as const) {
      it(`person task.create, top-level author holding ${label}: FIELD_NOT_WRITABLE, kept`, async () => {
        const { audit } = await refusedOnce(
          'person',
          'task.create',
          { operationId: randomUUID(), author: value, fields: { title: 'x' } },
          { status: 422, code: 'FIELD_NOT_WRITABLE' },
        );
        expect(audit?.['attempted']).toStrictEqual({
          author: JSON.stringify(value).slice(1, -1),
        });
      });

      it(`person task.create, fields.source holding ${label}: SOURCE_SPOOFED, kept`, async () => {
        const { audit } = await refusedOnce(
          'person',
          'task.create',
          { operationId: randomUUID(), fields: { title: 'x', source: value } },
          { status: 403, code: 'SOURCE_SPOOFED' },
        );
        expect(audit?.['attempted']).not.toBeNull();
      });

      it(`agent task.queue, top-level actor_id holding ${label}: FIELD_NOT_WRITABLE, kept`, async () => {
        const { audit } = await refusedOnce(
          'agent',
          'task.queue',
          { operationId: randomUUID(), actor_id: value },
          { status: 422, code: 'FIELD_NOT_WRITABLE' },
        );
        expect(audit?.['attempted']).not.toBeNull();
      });

      it(`person task.read, top-level actor_id holding ${label}: FIELD_NOT_WRITABLE, kept`, async () => {
        const { audit } = await refusedOnce(
          'person',
          'task.read',
          { recordId: task.id, actor_id: value },
          { status: 422, code: 'FIELD_NOT_WRITABLE' },
        );
        expect(audit?.['attempted']).not.toBeNull();
      });
    }

    it('person task.update, actor_id "a\\u0000b": FIELD_NOT_WRITABLE, kept', async () => {
      await refresh();
      await refusedOnce(
        'person',
        'task.update',
        {
          operationId: randomUUID(),
          recordId: task.id,
          expectedRevision: task.revision,
          fields: { title: 'x' },
          actor_id: `a${NUL}b`,
        },
        { status: 422, code: 'FIELD_NOT_WRITABLE' },
      );
    });

    it('person task.create, a field key holding NUL: FIELD_UNKNOWN, registered, replayed alike', async () => {
      const body = { operationId: randomUUID(), fields: { title: 'x', [`x${NUL}`]: 1 } };
      const { answer, before, after } = await refusedOnce('person', 'task.create', body, {
        status: 422,
        code: 'FIELD_UNKNOWN',
      });
      // The name is answered as it is stored, so a replay's bytes are these.
      expect(answer.body['names']).toStrictEqual(['x\\u0000']);
      expect(after['operations']).toBe(Number(before['operations']) + 1);
      const replay = await send('person', 'task.create', JSON.stringify(body));
      expect(replay).toStrictEqual(answer);
    });

    it('the chain still verifies', async () => {
      const report = await fixture.db.app.withBusiness(fixture.business, (tx) =>
        verifyAuditChain(tx),
      );
      expect(report.intact).toBe(true);
    });
  });
});
