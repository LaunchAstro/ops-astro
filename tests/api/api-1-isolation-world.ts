// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation's world, against a fresh Postgres: Alpha and Bravo, Alpha's
// two client tasks each with one person holding read on it alone, an agent
// under a live delegation for one task, and a second Alpha person whose own
// held reservation and live lease the agent must never reach. Every id and
// title is labelled as it is made, so a leak is named and never printed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import type { Hono } from 'hono';
import { buildCatalogue, type CatalogueRow } from '../../packages/core-wire/src/index.ts';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';

export type Name = 'client1' | 'client2' | 'bravo' | 'other';
/** Whose delegated work a task, title, lease or reservation is: the agent's own, or the second Alpha person's. */
export type Owner = 'delegated' | 'other';

export const detail = (body: Record<string, unknown>): Record<string, unknown> =>
  body['detail'] as Record<string, unknown>;

export let fixture: ApiFixture;
export let api: Hono;
export let rows: CatalogueRow[];
export const task: Record<'alpha' | 'client1' | 'client2' | 'bravo', string> = {
  alpha: '',
  client1: '',
  client2: '',
  bravo: '',
};
export let clientOne: Member;
export let clientTwo: Member;
export let bravoBusinessId: string;
/** The agent's own login, and the delegation its pickup minted for one task. */
export let agentToken: string;
export let delegation: string;
export let delegatedTask: string;
/** A second Alpha person's own claims: one approved and held, one picked up and live. */
export let foreignLease: { leaseId: string; fence: unknown };
export let foreignReservation: string;
export let foreignPersonId = '';
export let foreignTaskId = '';
/** Raw id or title to its label, so a leak is named and no record value is printed. */
const labels = new Map<string, string>();

export function label(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null), (_key, field: unknown) =>
    typeof field === 'string'
      ? [...labels].reduce((text, [raw, name]) => text.replaceAll(raw, name), field)
      : field,
  );
}

export const through = ((url: string | URL, init?: RequestInit) =>
  api.fetch(new Request(`http://api.test${String(url)}`, init))) as typeof fetch;

async function create(businessKey: string, token: string, name: Name): Promise<string> {
  const title = `made-up ${name} ${randomUUID()}`;
  const answer = await post(
    api,
    `/api/b/${businessKey}/task/create`,
    { operationId: randomUUID(), fields: { title } },
    authorised(token),
  );
  const id = (answer.body as { recordId?: string }).recordId;
  if (answer.status !== 200 || typeof id !== 'string') throw new Error(JSON.stringify(answer));
  labels.set(id, `<${name} task>`).set(title, `<${name} title>`);
  return id;
}

/** Registers the world's setup and teardown in the calling suite. */
export function useIsolationWorld(): void {
  beforeAll(async () => {
    fixture = await createApiFixture('api_1_isolation');
    api = fixture.compose();
    rows = buildCatalogue([]);
    const alphaToken = await seedClients();
    await seedDelegations(alphaToken);
  }, 120_000);
  afterAll(async () => await fixture?.drop());
}

/** Bravo with its writer and task, Alpha's two client tasks and their one-grant people. */
async function seedClients(): Promise<string> {
  const bravo = await insertBusiness(fixture.db.app, 'bravo');
  bravoBusinessId = bravo;
  await installSpine(fixture.db.app, bravo);
  const bravoWriter = await enrol(fixture.db.app, bravo, 'bravo-writer');
  labels.set(bravo, '<bravo business>');
  labels.set(bravoWriter.personId, '<bravo person>').set(bravoWriter.actorId, '<bravo person>');
  await fixture.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoWriter, 'read');
    await grantTo(tx, bravoWriter, 'write');
  });
  const alphaToken = await tokenFor(fixture.member.presented.subject);
  task.client1 = await create('alpha', alphaToken, 'client1');
  task.client2 = await create('alpha', alphaToken, 'client2');
  task.bravo = await create('bravo', await tokenFor(bravoWriter.presented.subject), 'bravo');
  clientOne = await enrol(fixture.db.app, fixture.business, 'client-one-person');
  clientTwo = await enrol(fixture.db.app, fixture.business, 'client-two-person');
  for (const [member, name] of [
    [clientOne, 'client1'],
    [clientTwo, 'client2'],
  ] as const) {
    labels.set(member.personId, `<${name} person>`).set(member.actorId, `<${name} person>`);
  }
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, clientOne, 'read', { kind: 'record', id: task.client1 });
    await grantTo(tx, clientTwo, 'read', { kind: 'record', id: task.client2 });
  });
  return alphaToken;
}

/** The agent's own delegation, then the second Alpha person's held reservation and live lease. */
async function seedDelegations(alphaToken: string): Promise<void> {
  ({ agentToken, delegation, delegatedTask } = await pickUp(alphaToken, 'delegated'));
  const otherPerson = await enrol(fixture.db.app, fixture.business, 'other-decider');
  foreignPersonId = otherPerson.personId;
  labels.set(otherPerson.personId, '<other person>').set(otherPerson.actorId, '<other person>');
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
      await grantTo(tx, otherPerson, action);
    }
  });
  const otherToken = await tokenFor(otherPerson.presented.subject);
  // Their held reservation, for the agent's own purpose; and their live lease, held
  // by a second agent under their delegation for that same purpose, so only the
  // delegation's one task tells the two agents' leases apart.
  foreignReservation = await approve(otherToken, 'other');
  const secondAgent = `agent-${randomUUID()}`;
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      fixture.business,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [
        fixture.business,
        randomUUID(),
        await insertLogin(tx, secondAgent),
        actorId,
        otherPerson.actorId,
      ],
    );
  });
  const theirs = await pickUp(otherToken, 'other', secondAgent);
  foreignTaskId = theirs.delegatedTask;
  foreignLease = { leaseId: theirs.leaseId, fence: theirs.fence };
}

/** An Alpha person proposes and approves one task: its reservation, held for pickup. */
async function approve(personToken: string, owner: Owner): Promise<string> {
  const asPerson = async (path: string, body: Record<string, unknown>) =>
    (await post(api, `/api/b/alpha${path}`, body, authorised(personToken))).body;
  const title = `made-up ${owner} ${randomUUID()}`;
  const made = await asPerson('/task/create', { operationId: randomUUID(), fields: { title } });
  labels.set(String(made['recordId']), `<${owner} task>`).set(title, `<${owner} title>`);
  const proposed = await asPerson('/task/propose', {
    operationId: randomUUID(),
    recordId: made['recordId'],
    expectedRevision: made['revision'],
    purpose: 'api_1_isolation',
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { instruction: 'draft a made-up reply' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  });
  const decided = await asPerson('/task/decide', {
    operationId: randomUUID(),
    gateId: detail(proposed)['gateId'],
    versionId: detail(proposed)['versionId'],
    decision: 'approve',
    note: 'approved for the API-1 delegation crossing',
  });
  const reservationId = detail(decided)['reservationId'];
  if (typeof reservationId !== 'string') throw new Error(JSON.stringify(decided));
  labels.set(reservationId, `<${owner} reservation>`);
  return reservationId;
}

/** An Alpha person approves one task, and an agent picks it up under that person's delegation. */
async function pickUp(personToken: string, owner: Owner, agentSubject = fixture.agent.subject) {
  const token = await tokenFor(agentSubject);
  const picked = await post(
    api,
    '/api/a/b/alpha/task/pickup',
    { operationId: randomUUID(), reservationId: await approve(personToken, owner) },
    authorised(token),
  );
  if (picked.status !== 200) throw new Error(JSON.stringify(picked));
  const taskId = String(detail(picked.body)['taskId']);
  labels.set(taskId, `<${owner} task>`);
  const held = detail(picked.body);
  const leaseId = String(held['leaseId']);
  labels.set(leaseId, `<${owner} lease>`);
  return {
    agentToken: token,
    delegation: String(held['credential']),
    delegatedTask: taskId,
    leaseId,
    fence: held['fence'],
  };
}
