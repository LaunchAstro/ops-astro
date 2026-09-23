// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world for the pickup-replay suites: the mounted API over a fresh
// database, an approver whose grants a case can revoke, and the counts that
// say whether a replay minted anything.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

type Operation = Parameters<typeof pathOf>[0];
type Body = Readonly<Record<string, unknown>>;

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

export interface Approver extends Member {
  readonly token: string;
  readonly grants: Readonly<Record<string, string>>;
}

export interface Picked {
  readonly taskId: string;
  readonly reservationId: string;
  readonly body: Body;
  /** The answer the client never read: the "lost" response. */
  readonly lost: Answer;
  readonly credential: string;
}

export interface Counts {
  readonly leases: number;
  readonly delegations: number;
  readonly reservations: number;
  readonly attempts: number;
}

export interface ReplayWorld {
  readonly fixture: ApiFixture;
  api: Hono;
  readonly agentToken: string;
  approver(name: string): Promise<Approver>;
  approved(by: Approver, purpose: string): Promise<{ taskId: string; reservationId: string }>;
  asAgent(name: Operation, body: Body, credential?: string, token?: string): Promise<Answer>;
  pickUp(by: Approver, purpose: string): Promise<Picked>;
  counts(taskId: string): Promise<Counts>;
  scalar(text: string, values: readonly unknown[]): Promise<string | null>;
  /** A second agent actor in the same business, with its own login. */
  otherAgentToken(): Promise<string>;
}

const agentPath = (name: Operation, key = BUSINESS_KEY): string => `/api/a/b/${key}${pathOf(name)}`;
const personPath = (name: Operation): string => `/api/b/${BUSINESS_KEY}${pathOf(name)}`;

export async function replayWorld(part: string): Promise<ReplayWorld> {
  const fixture = await createApiFixture(part);
  const agentToken = await tokenFor(fixture.agent.subject);

  const scalar = async (text: string, values: readonly unknown[]): Promise<string | null> => {
    const rows = await fixture.db.admin.execute<{ readonly v: string | null }>(text, [...values]);
    return rows[0]?.v ?? null;
  };

  const world: ReplayWorld = {
    fixture,
    api: fixture.compose(),
    agentToken,
    async approver(name) {
      const member = await enrol(fixture.db.app, fixture.business, name);
      const grants: Record<string, string> = {};
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
          // eslint-disable-next-line no-await-in-loop
          grants[action] = await grantTo(tx, member, action);
        }
      });
      return { ...member, grants, token: await tokenFor(member.presented.subject) };
    },
    async approved(by, purpose) {
      const person = async (name: Operation, body: Body): Promise<Answer> =>
        await post(world.api, personPath(name), body, authorised(by.token));
      const created = await person('task.create', {
        operationId: randomUUID(),
        fields: { title: `pickup replay ${purpose}` },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const proposed = await person('task.propose', {
        operationId: randomUUID(),
        recordId: created.body['recordId'],
        expectedRevision: created.body['revision'],
        purpose,
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
      const decided = await person('task.decide', {
        operationId: randomUUID(),
        gateId: detailOf(proposed)['gateId'],
        versionId: detailOf(proposed)['versionId'],
        decision: 'approve',
        note: 'approved for an agent to work',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      return {
        taskId: String(created.body['recordId']),
        reservationId: String(detailOf(decided)['reservationId']),
      };
    },
    async asAgent(name, body, credential, token = agentToken) {
      return await post(world.api, agentPath(name), body, {
        ...authorised(token),
        ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
      });
    },
    async pickUp(by, purpose) {
      const { taskId, reservationId } = await world.approved(by, purpose);
      const body = { operationId: randomUUID(), reservationId };
      const lost = await world.asAgent('task.pickup', body);
      expect(lost.status, JSON.stringify(lost.body)).toBe(200);
      const credential = String(detailOf(lost)['credential']);
      return { taskId, reservationId, body, lost, credential };
    },
    async counts(taskId) {
      const count = async (text: string): Promise<number> =>
        Number(await scalar(text, [fixture.business, taskId]));
      return {
        leases: await count(
          `select count(*)::text as v from public.leases where business_id = $1 and task_id = $2`,
        ),
        delegations: await count(
          `select count(*)::text as v from public.delegations
            where business_id = $1 and purpose_scope_id = $2`,
        ),
        reservations: await count(
          `select count(*)::text as v from public.reservations res
             join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
            where res.business_id = $1 and run.task_id = $2`,
        ),
        attempts: await count(
          `select count(*)::text as v from public.attempts att
             join public.reservations res
               on res.business_id = att.business_id and res.id = att.reservation_id
             join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
            where att.business_id = $1 and run.task_id = $2`,
        ),
      };
    },
    scalar,
    async otherAgentToken() {
      const subject = `agent-${randomUUID()}`;
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        const actorId = randomUUID();
        await tx.query(
          `insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`,
          [fixture.business, actorId],
        );
        const loginId = await insertLogin(tx, subject);
        await tx.query(
          `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
           values ($1, $2, $3, $4, $5)`,
          [fixture.business, randomUUID(), loginId, actorId, fixture.member.actorId],
        );
      });
      return await tokenFor(subject);
    },
  };
  return world;
}
