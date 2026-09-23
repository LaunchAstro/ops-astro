// SPDX-License-Identifier: AGPL-3.0-only
//
// The support controls' shared journey: a composed boundary, a manager, a
// reader, and the calls that bring a lineage, a reservation and a lease into
// existence through the routes that own them.
//
// Its own file because the two control suites both need it and the per-file
// review cap is 400 changed lines. Nothing here writes a row a route would
// write: grants are issued the way `tests/api/fixture.ts` issues them (a root
// grant is an administrative act and there is no route for one), and every
// lineage, reservation, lease and revocation comes from an operation.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { grantTo, enrol, type Member } from '../commands/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

export const personPath = (name: string): string =>
  `/api/b/${BUSINESS_KEY}/${name.replace('.', '/')}`;
export const agentPath = (name: string): string =>
  `/api/a/b/${BUSINESS_KEY}/${name.replace('.', '/')}`;

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

export const PROPOSAL = {
  purpose: 'draft_the_reply',
  maximumMinor: 2_500,
  currency: 'AUD',
  payload: { instruction: 'draft a reply to the client' },
  step: { kind: 'compose', payload: { tone: 'plain' } },
} as const;

/** The body of an answer that had to succeed for the case to mean anything. */
function must(answer: Answer, what: string): Record<string, unknown> {
  if (answer.status !== 200) {
    throw new Error(`${what} answered ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

export interface Controls {
  readonly fixture: ApiFixture;
  readonly api: Hono;
  /** The fixture's member, who also holds `manage` on tasks: the grant manager. */
  readonly manager: Member;
  /** A person holding `read` on tasks and nothing else. */
  readonly reader: Member;
  /** The id of the reader's one grant, issued administratively. */
  readonly readerGrantId: string;
  asPerson(name: string, body: Readonly<Record<string, unknown>>, as?: Member): Promise<Answer>;
  asAgent(
    name: string,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer>;
  createTask(title: string): Promise<{ id: string; revision: number }>;
  propose(taskId: string, revision: number, purpose?: string): Promise<Record<string, unknown>>;
  approve(proposal: Record<string, unknown>): Promise<string>;
  pickup(reservationId: string, leaseSeconds?: number): Promise<Record<string, unknown>>;
  count(sql: string, parameters: readonly unknown[]): Promise<number>;
  drop(): Promise<void>;
}

export async function createControls(part: string): Promise<Controls> {
  const fixture = await createApiFixture(part);
  const api = fixture.compose();
  const manager = fixture.member;
  const reader = await enrol(fixture.db.app, fixture.business, 'reader');
  let readerGrantId = '';
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, manager, 'manage');
    readerGrantId = await grantTo(tx, reader, 'read');
  });
  const tokens = new Map<string, string>();
  const tokenOf = async (member: Member): Promise<string> => {
    const known = tokens.get(member.actorId);
    if (known !== undefined) return known;
    const minted = await tokenFor(member.presented.subject);
    tokens.set(member.actorId, minted);
    return minted;
  };
  const agentToken = await tokenFor(fixture.agent.subject);

  const asPerson = async (
    name: string,
    body: Readonly<Record<string, unknown>>,
    as: Member = manager,
  ): Promise<Answer> =>
    await post(
      api,
      personPath(name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenOf(as)),
    );

  const asAgent = async (
    name: string,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer> =>
    await post(
      api,
      agentPath(name),
      { operationId: randomUUID(), ...body },
      {
        ...authorised(agentToken),
        ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
      },
    );

  return {
    fixture,
    api,
    manager,
    reader,
    readerGrantId,
    asPerson,
    asAgent,
    async createTask(title) {
      const body = must(await asPerson('task.create', { fields: { title } }), 'task.create');
      return { id: String(body['recordId']), revision: Number(body['revision']) };
    },
    async propose(taskId, revision, purpose = PROPOSAL.purpose) {
      const answer = await asPerson('task.propose', {
        recordId: taskId,
        expectedRevision: revision,
        ...PROPOSAL,
        purpose,
      });
      return detailOf({ status: 200, body: must(answer, 'task.propose') });
    },
    async approve(proposal) {
      const answer = await asPerson('task.decide', {
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note: 'approved so an agent can work it',
      });
      return String(detailOf({ status: 200, body: must(answer, 'task.decide') })['reservationId']);
    },
    async pickup(reservationId, leaseSeconds) {
      const answer = await asAgent('task.pickup', {
        reservationId,
        ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
      });
      return detailOf({ status: 200, body: must(answer, 'task.pickup') });
    },
    async count(sql, parameters) {
      const rows = await fixture.db.admin.execute<{ readonly n: string }>(sql, [...parameters]);
      return Number(rows[0]?.n ?? 0);
    },
    async drop() {
      await fixture.drop();
    },
  };
}
