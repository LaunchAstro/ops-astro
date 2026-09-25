// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.capabilities` and the pre-pickup agent login, held to the contract.
//
// Two cases of minimum contract 8.2, both over HTTP through the mounted app.
// Case 3 (ledger I05): a member in their own business who holds no grant calls
// every operation and is refused `SCOPE_NOT_GRANTED`; a denied read is never a
// success with an empty list, and `session.capabilities` is a read like the
// rest. Case 9 (ledger I12): an agent login before any pickup reaches
// `task.queue` and `task.pickup` and nothing else. Every other exported
// operation is refused `DELEGATION_EXCLUDES_OPERATION`, and `task.decide`
// `DELEGATION_EXCLUDES_DECISION`. The operation list is the surface table
// itself, so an operation added later is in this case without anybody adding
// it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { enrol, type Member } from './fixture.ts';
import {
  COMMAND_SURFACE,
  READS,
  pathOf,
} from '../../packages/core-records/src/commands/surface.ts';

// Like the other database files, these cases skip without a database
// rather than fail in beforeAll (the CI local checks job has none).
const serverUrl = databaseUrlFromEnvironment();
let fixture: ApiFixture;
let api: Hono;
let memberToken: string;
let agentToken: string;
let noah: Member;
let noahToken: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  fixture = await createApiFixture('capabilities_contract');
  api = fixture.compose();
  memberToken = await tokenFor(fixture.member.presented.subject);
  agentToken = await tokenFor(fixture.agent.subject);
  // A member of the business with no grant at all: the contract's R2.
  noah = await enrol(fixture.db.app, fixture.business, 'noah');
  noahToken = await tokenFor(noah.presented.subject);
}, 60_000);

afterAll(async () => {
  if (serverUrl !== undefined) await fixture.drop();
});

const asPerson = async (token: string, name: string, body: Record<string, unknown>) =>
  await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name as never)}`, body, authorised(token));

const asAgent = async (name: string, body: Record<string, unknown>, credential?: string) =>
  await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name as never)}`, body, {
    ...authorised(agentToken),
    ...(credential === undefined ? {} : { [DELEGATION_HEADER]: credential }),
  });

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? answer.body;

describe.skipIf(serverUrl === undefined)(
  'session.capabilities for a member with no grant (contract case 3, I05)',
  () => {
    it('is refused SCOPE_NOT_GRANTED with no capability body', async () => {
      const denied = await asPerson(noahToken, 'session.capabilities', {});
      expect(denied.status).toBe(403);
      expect(denied.body['refused']).toBe(true);
      expect(denied.body['code']).toBe('SCOPE_NOT_GRANTED');
      // Denied, not an empty success: none of the answer's own fields is here.
      for (const field of ['ok', 'grants', 'personId', 'businessKey']) {
        expect(denied.body[field], field).toBeUndefined();
      }
    });

    it('still answers a granted member with their own grants', async () => {
      const granted = await asPerson(memberToken, 'session.capabilities', {});
      expect(granted.status).toBe(200);
      expect(granted.body['ok']).toBe(true);
      expect(granted.body['personId']).toBe(fixture.member.personId);
      const pairs = (granted.body['grants'] as { collection: string; action: string }[]).map(
        (grant) => `${grant.collection}:${grant.action}`,
      );
      expect(pairs.toSorted()).toStrictEqual([
        'task:assign',
        'task:comment',
        'task:decide',
        'task:read',
        'task:write',
      ]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'an agent login before any pickup (contract case 9, I12)',
  () => {
    it('generates its list from the surface table, the reads included', () => {
      const names = new Set(COMMAND_SURFACE.map((declaration) => declaration.name));
      for (const read of READS) expect(names.has(read), read).toBe(true);
      for (const name of ['task.queue', 'task.pickup', 'task.decide', 'session.capabilities']) {
        expect(names.has(name as never), name).toBe(true);
      }
    });

    it('refuses every exported operation except the queue and a pickup, and decide as a decision', async () => {
      const answers = new Map<string, { status: number; code: unknown }>();
      for (const declaration of COMMAND_SURFACE) {
        if (declaration.name === 'task.queue' || declaration.name === 'task.pickup') continue;
        // Sequential: one agent actor and one register.
        // eslint-disable-next-line no-await-in-loop
        const answer = await asAgent(declaration.name, {
          operationId: randomUUID(),
          // Each operand the agent entry reads before the delegation (Sol 6
          // AUTHORITY-2 and -3) is well formed, so the answer is the exclusion:
          // no stray recordId on the capabilities read, and a typed handback.
          ...(declaration.name === 'session.capabilities' ? {} : { recordId: randomUUID() }),
          ...(declaration.name === 'task.handback'
            ? { leaseId: randomUUID(), fence: 1, outcome: 'completed' }
            : {}),
        });
        answers.set(declaration.name, { status: answer.status, code: answer.body['code'] });
      }
      const expected = new Map(
        [...answers.keys()].map((name) => [
          name,
          {
            status: 403,
            code:
              name === 'task.decide'
                ? 'DELEGATION_EXCLUDES_DECISION'
                : 'DELEGATION_EXCLUDES_OPERATION',
          },
        ]),
      );
      expect(Object.fromEntries(answers)).toStrictEqual(Object.fromEntries(expected));
      expect(answers.size).toBe(COMMAND_SURFACE.length - 2);
    });

    it('reads the queue, picks up, and then works under the live delegation as before', async () => {
      const queue = await asAgent('task.queue', { operationId: randomUUID() });
      expect(queue.status).toBe(200);

      const created = await asPerson(memberToken, 'task.create', {
        operationId: randomUUID(),
        fields: { title: 'a task an agent picks up' },
      });
      expect(created.status).toBe(200);
      const taskId = String(created.body['recordId']);
      const proposed = await asPerson(memberToken, 'task.propose', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: Number(created.body['revision']),
        purpose: `draft_${randomUUID().slice(0, 8)}`,
        maximumMinor: 3_000,
        currency: 'AUD',
        payload: { instruction: 'draft a reply' },
        step: { kind: 'compose', payload: {} },
      });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
      const decided = await asPerson(memberToken, 'task.decide', {
        operationId: randomUUID(),
        gateId: detail(proposed)['gateId'],
        versionId: detail(proposed)['versionId'],
        decision: 'approve',
        note: 'approved so an agent can work it',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);

      const pickedUp = await asAgent('task.pickup', {
        operationId: randomUUID(),
        reservationId: detail(decided)['reservationId'],
      });
      expect(pickedUp.status, JSON.stringify(pickedUp.body)).toBe(200);
      const credential = String(detail(pickedUp)['credential']);

      // After the pickup the delegation answers: its own purpose, and a read of
      // its own task, while decide stays a person's.
      const capabilities = await asAgent(
        'session.capabilities',
        { operationId: randomUUID() },
        credential,
      );
      expect(capabilities.status, JSON.stringify(capabilities.body)).toBe(200);
      expect(capabilities.body['purposeScope']).toStrictEqual({ kind: 'record', id: taskId });
      const read = await asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: taskId },
        credential,
      );
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const decide = await asAgent(
        'task.decide',
        { operationId: randomUUID(), gateId: detail(proposed)['gateId'], decision: 'approve' },
        credential,
      );
      expect(decide.body['code']).toBe('DELEGATION_EXCLUDES_DECISION');
    });
  },
);
