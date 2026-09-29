// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b over a real database: the worker as its own process, `task.propose` on
// the agent route, and the served-identity route.
//
// `worker_boundary`, the process half: a worker process, started with an agent
// login and one delegation and nothing else, proposes through a served API and
// the proposal appears as version 1 with a pending gate. Red with no worker
// process. The structural half is `tests/worker/worker-boundary.test.ts`.
//
// `T2 propose key`: `task.propose` asks `task:write` of a person and of an
// agent's delegation alike, and an agent whose delegation lacks it is refused.
// Data separation: the proposal reaches only the delegation's own task in its
// own business; a sibling task, a foreign delegation and another business key
// are refused; the person routes refuse an agent login.
//
// `T2 identity local` is `t2b-identity-route.test.ts`.
// `T2 canary token`, the command-line half: neither credential the worker was
// handed reaches its output.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { readIdentity } from '../../apps/api/identity.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { detailOf, proposal, runWorker, type Ran } from './t2b-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROOT = resolve(import.meta.dirname, '../..');

if (serverUrl === undefined) {
  console.warn('api/t2b: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Name = Parameters<typeof pathOf>[0];

describe.skipIf(serverUrl === undefined)(
  'T2b: the worker and task.propose on the agent route',
  () => {
    let fixture: ApiFixture;
    let api: Hono;
    let server: ServerType;
    let origin: string;
    let personToken: string;
    let agentToken: string;
    const task: Record<
      'worker' | 'route' | 'noWrite' | 'sibling',
      { id: string; revision: number }
    > = {
      worker: { id: '', revision: 0 },
      route: { id: '', revision: 0 },
      noWrite: { id: '', revision: 0 },
      sibling: { id: '', revision: 0 },
    };
    const credential = { worker: '', route: '', noWrite: '', foreign: '' };

    async function asPerson(name: Name, body: object, token = personToken): Promise<Answer> {
      return await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(token));
    }

    async function asAgent(name: Name, body: object, held: string, key = BUSINESS_KEY) {
      return await post(api, `/api/a/b/${key}${pathOf(name)}`, body, {
        ...authorised(agentToken),
        'x-agent-delegation': held,
      });
    }

    async function createTask(title: string): Promise<{ id: string; revision: number }> {
      const answer = await asPerson('task.create', {
        operationId: randomUUID(),
        fields: { title },
      });
      if (answer.status !== 200) throw new Error(`task.create answered ${answer.status}`);
      return { id: String(answer.body['recordId']), revision: Number(answer.body['revision']) };
    }

    /** One live delegation per agent and purpose, so each case mints its own purpose word. */
    async function mint(
      taskId: string,
      actions: ('read' | 'comment' | 'write')[],
      purpose: string,
      agent?: string,
    ) {
      return await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        const minted = await mintDelegation(tx, {
          agentActorId: agent ?? fixture.agentActorId,
          delegatePersonId: fixture.member.personId,
          mintedByActorId: fixture.member.actorId,
          purpose,
          collections: ['task'],
          actions,
          purposeScope: { kind: 'record', id: taskId },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        if (!minted.ok) throw new Error(`fixture: mint ${purpose} refused ${minted.refusal.code}`);
        return minted.value.credential;
      });
    }

    async function proposalsOn(taskId: string): Promise<readonly Record<string, unknown>[]> {
      const read = await asPerson('task.read', { recordId: taskId });
      const detail = (read.body['task'] ?? detailOf(read)['task']) as Record<string, unknown>;
      return (detail['proposals'] as Record<string, unknown>[] | undefined) ?? [];
    }

    beforeAll(async () => {
      fixture = await createApiFixture('t2b');
      api = fixture.compose(undefined, readIdentity(ROOT));
      personToken = await tokenFor(fixture.member.presented.subject);
      agentToken = await tokenFor(fixture.agent.subject);
      task.worker = await createTask('the task the worker proposes on');
      task.route = await createTask('the task the route cases propose on');
      task.noWrite = await createTask('a task whose delegation carries no write');
      task.sibling = await createTask('a sibling task outside every delegation');
      credential.worker = await mint(task.worker.id, ['read', 'comment', 'write'], 'worker');
      credential.route = await mint(task.route.id, ['read', 'comment', 'write'], 'route');
      credential.noWrite = await mint(task.noWrite.id, ['read', 'comment'], 'no_write');
      const otherAgent = randomUUID();
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await tx.query(
          `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
          [fixture.business, otherAgent],
        );
      });
      credential.foreign = await mint(
        task.route.id,
        ['read', 'comment', 'write'],
        'route',
        otherAgent,
      );
      server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
      await new Promise<void>((done) => {
        server.once('listening', () => done());
      });
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, 120_000);

    afterAll(async () => {
      await new Promise<void>((done) => {
        if (server === undefined) done();
        else server.close(() => done());
      });
      await fixture?.drop();
    });

    describe('worker_boundary: the worker process', () => {
      let ran: Ran;

      beforeAll(async () => {
        ran = await runWorker({
          OPS_ASTRO_API_URL: origin,
          OPS_ASTRO_BUSINESS: BUSINESS_KEY,
          OPS_ASTRO_TOKEN: agentToken,
          OPS_ASTRO_DELEGATION: credential.worker,
        });
      }, 60_000);

      it('proposes one synthetic change, seen as version 1 with a pending gate', async () => {
        expect(ran.stderr).toBe('');
        expect(ran.code).toBe(0);
        const answer = JSON.parse(ran.stdout.trim()) as Record<string, unknown>;
        expect(answer['proposed']).toMatchObject({ version: 1, taskId: task.worker.id });
        const [lineage] = await proposalsOn(task.worker.id);
        const versions = (lineage?.['versions'] ?? []) as Record<string, unknown>[];
        expect(versions.map((row) => row['version'])).toStrictEqual([1]);
        expect(versions[0]?.['gate']).toMatchObject({ state: 'pending' });
      });

      it('reaches only its own task: the sibling carries no proposal', async () => {
        expect(await proposalsOn(task.sibling.id)).toStrictEqual([]);
      });

      it('T2 canary token: neither credential reaches the worker’s output', () => {
        for (const secret of [agentToken, credential.worker]) {
          expect(ran.stdout).not.toContain(secret);
          expect(ran.stderr).not.toContain(secret);
        }
      });
    });

    describe('T2 propose key: task.propose on the agent route', () => {
      it('an agent whose delegation carries task:write proposes on its own task', async () => {
        const answer = await asAgent(
          'task.propose',
          proposal(task.route.id, task.route.revision),
          credential.route,
        );
        expect(answer.status).toBe(200);
        expect(detailOf(answer)['version']).toBe(1);
      });

      it('an agent whose delegation lacks task:write is refused', async () => {
        const answer = await asAgent(
          'task.propose',
          proposal(task.noWrite.id, task.noWrite.revision),
          credential.noWrite,
        );
        expect(answer.body).toMatchObject({ refused: true, code: 'DELEGATION_OUT_OF_PURPOSE' });
      });

      it('a person without task:write is refused, a person with it is not', async () => {
        const reader = await enrol(fixture.db.app, fixture.business, 'reader');
        await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          await grantTo(tx, reader, 'read');
        });
        const refused = await asPerson(
          'task.propose',
          proposal(task.sibling.id, task.sibling.revision),
          await tokenFor(reader.presented.subject),
        );
        expect(refused.body).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
        expect(await proposalsOn(task.sibling.id)).toStrictEqual([]);
      });

      it('a proposal against a moved revision is refused VERSION_STALE with the current revision', async () => {
        const moved = await asPerson('task.update', {
          operationId: randomUUID(),
          recordId: task.route.id,
          expectedRevision: task.route.revision,
          fields: { title: 'edited first' },
        });
        expect(moved.status).toBe(200);
        const current = Number(moved.body['revision']);
        const answer = await asAgent(
          'task.propose',
          proposal(task.route.id, task.route.revision),
          credential.route,
        );
        expect(answer.body).toMatchObject({
          refused: true,
          code: 'VERSION_STALE',
          names: [`revision=${current}`],
        });
      });

      it('a sibling task is outside the delegation', async () => {
        const answer = await asAgent(
          'task.propose',
          proposal(task.sibling.id, task.sibling.revision),
          credential.route,
        );
        expect(answer.body).toMatchObject({ refused: true, code: 'DELEGATION_OUT_OF_PURPOSE' });
        expect(await proposalsOn(task.sibling.id)).toStrictEqual([]);
      });

      it('a foreign delegation is refused', async () => {
        const answer = await asAgent(
          'task.propose',
          proposal(task.route.id, 99),
          credential.foreign,
        );
        expect(answer.body).toMatchObject({ refused: true, code: 'DELEGATION_NOT_LIVE' });
      });

      it('another business key is refused before any task is looked at', async () => {
        const answer = await asAgent(
          'task.propose',
          proposal(task.route.id, 99),
          credential.route,
          'beta',
        );
        expect(answer.body).toMatchObject({ refused: true, code: 'AUTH_NO_AGENT_IDENTITY' });
      });

      it('the person routes refuse an agent login, and write nothing', async () => {
        const before = await proposalsOn(task.sibling.id);
        for (const name of ['task.read', 'task.propose', 'task.queue'] as const) {
          // oxlint-disable-next-line no-await-in-loop
          const answer = await asPerson(
            name,
            proposal(task.sibling.id, task.sibling.revision),
            agentToken,
          );
          expect(answer.body['refused'], name).toBe(true);
          expect(answer.status, name).toBeGreaterThanOrEqual(400);
        }
        expect(await proposalsOn(task.sibling.id)).toStrictEqual(before);
      });
    });

    describe('T2 isolation: each boundary the proposal crosses', () => {
      let other: Party;
      let first: Member;
      let second: Member;
      const read = async (who: Member, recordId: string) =>
        await asPerson('task.read', { recordId }, await tokenFor(who.presented.subject));

      beforeAll(async () => {
        const { db, business, member, agent, agentActorId } = fixture;
        const world = cq8World({ db, business, decider: member, agent, agentActorId, capId: '' });
        other = await world.party('t2bother');
        await db.app.withBusiness(business, async (tx) => await grantTo(tx, member, 'share'));
        first = await world.client(business, member, 't2b-client-1', task.worker.id);
        second = await world.client(business, member, 't2b-client-2', task.sibling.id);
      }, 60_000);

      it('T2 isolation: business to business', async () => {
        const [theirs] = other.tasks;
        const named = await asAgent(
          'task.propose',
          proposal(String(theirs?.id), 1),
          credential.worker,
        );
        expect(named.body).toMatchObject({ refused: true, code: 'DELEGATION_OUT_OF_PURPOSE' });
        const there = await asAgent(
          'task.propose',
          proposal(String(theirs?.id), 1),
          credential.worker,
          't2bother',
        );
        expect(there.body).toMatchObject({ refused: true, code: 'AUTH_NO_AGENT_IDENTITY' });
        const theirMember = await read(other.member, task.worker.id);
        expect(theirMember.body['refused']).toBe(true);
        // The worker's own task is the control: the query does find a lineage.
        const ids = [task.worker.id, ...other.tasks.map((one) => one.id)];
        const lineages = await fixture.db.admin.execute<{ task_id: string }>(
          'select task_id from public.proposal_lineages where task_id = any($1::uuid[])',
          [ids],
        );
        expect(lineages.map((row) => row.task_id)).toStrictEqual([task.worker.id]);
      });

      it('T2 isolation: client to client', async () => {
        expect((await read(first, task.worker.id)).status).toBe(200);
        for (const [who, recordId] of [
          [first, task.sibling.id],
          [second, task.worker.id],
          [other.tasks[0]?.client as Member, task.worker.id],
        ] as const) {
          // oxlint-disable-next-line no-await-in-loop
          const crossed = await read(who, recordId);
          expect(crossed.body['refused'], recordId).toBe(true);
          expect(JSON.stringify(crossed.body)).not.toContain('synthetic_comment');
        }
        const token = await tokenFor(first.presented.subject);
        const proposed = await asPerson('task.propose', proposal(task.worker.id, 1), token);
        expect(proposed.body['refused']).toBe(true);
      });

      it('T2 isolation: person to person', async () => {
        // A second person mints a live delegation, then keeps grants on the sibling only.
        const narrow = await enrol(fixture.db.app, fixture.business, 'narrow');
        const own = { kind: 'record', id: task.sibling.id } as const;
        const held = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
          const wide: string[] = [];
          for (const action of ['read', 'comment', 'write'] as const) {
            // oxlint-disable-next-line no-await-in-loop
            wide.push(await grantTo(tx, narrow, action), await grantTo(tx, narrow, action, own));
          }
          const minted = await mintDelegation(tx, {
            agentActorId: fixture.agentActorId,
            delegatePersonId: narrow.personId,
            mintedByActorId: narrow.actorId,
            purpose: 'person_to_person',
            collections: ['task'],
            actions: ['read', 'comment', 'write'],
            purposeScope: own,
            expiresAt: new Date(Date.now() + 3_600_000),
          });
          if (!minted.ok) throw new Error(`fixture: mint refused ${minted.refusal.code}`);
          // oxlint-disable-next-line no-await-in-loop
          for (const grant of wide.filter((_, at) => at % 2 === 0)) await revokeGrant(tx, grant);
          return minted.value.credential;
        });
        const live = await asAgent(
          'task.read',
          { operationId: randomUUID(), recordId: task.sibling.id },
          held,
        );
        expect(live.status, 'the delegation is live on its own task').toBe(200);
        const before = await proposalsOn(task.route.id);
        const borrowed = await asAgent('task.propose', proposal(task.route.id, 2), held);
        expect(borrowed.body).toMatchObject({ refused: true, code: 'DELEGATION_OUT_OF_PURPOSE' });
        const token = await tokenFor(narrow.presented.subject);
        const direct = await asPerson('task.propose', proposal(task.route.id, 2), token);
        expect(direct.body).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
        expect(await proposalsOn(task.route.id)).toStrictEqual(before);
      });
    });
  },
);
