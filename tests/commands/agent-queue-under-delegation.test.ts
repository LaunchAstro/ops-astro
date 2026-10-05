// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's work queue while it works one client's task (#169).
//
// `task.queue` is the agent login's business-wide work discovery before any
// pickup (minimum contract 8.2 case 9). Once a person has delegated a task to
// it, the agent is working for that task's client, and the queue it reads
// shows that client's queued work only: its queue never shows another
// client's reservation, task, purpose slug or held amount, with or without
// the credential presented, and a repeated read is served again rather than
// replayed. Outside a delegation nothing changes: the agent before a pickup
// and after its handback, another agent, and a person reading the queue see
// all of it.
//
// The blocks run in file order over one world: the pickup in the second
// block is the delegation the next two read under, and the handback ends it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, detailOf, type AgentWorld, type Decider } from './agent-fixture.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('agent-queue-under-delegation: DATABASE_URL is unset, so nothing here ran.');
}

/** Client B's queued work names client B in its purpose slug: the leak this proves shut. */
const CLIENT_B_SLUG = `quote_for_bramble_legal_${randomUUID().slice(0, 8)}`;
const CLIENT_B_HELD = 4_321;

type Body = Readonly<Record<string, unknown>>;
type Queue = readonly Record<string, unknown>[];

interface Queued {
  readonly taskId: string;
  readonly reservationId: string;
}

let world: AgentWorld;
let person: Decider;
/** Client A's task the person delegates to the agent. */
let delegated: Queued;
/** Client A's other queued work, which the delegated agent still sees. */
let sameClient: Queued;
/** Client B's queued work, whose slug names client B. */
let otherClient: Queued;
/** More of client B's work, which the second agent picks up. */
let otherClientPicked: Queued;
/** A second agent login of the business. */
let otherAgent: (body: Body) => Promise<CommandResult>;
/** The agent's queue read before any pickup, which a replay repeats. */
const coldRead = { command: 'task.queue', operationId: randomUUID() };
/** The delegation for client A's task, while it is live. */
let live: { readonly credential: string; readonly leaseId: string; readonly fence: number };

/** A setup step's detail, with the record it named, or the refusal thrown. */
const ok = (result: CommandResult, what: string): Record<string, unknown> => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

const queueOf = (answer: CommandResult): Queue => {
  expect(isCommandRefusal(answer)).toBe(false);
  return detailOf(answer)['queue'] as Queue;
};

const reservations = (queue: Queue): unknown[] => queue.map((entry) => entry['reservationId']);

/** The person's command, which must succeed. */
const asPerson = async (body: Body): Promise<Record<string, unknown>> =>
  ok(await world.asPerson(person, { operationId: randomUUID(), ...body }), String(body['command']));

const revisionOf = async (recordId: string): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where business_id = $1 and id = $2`,
    [world.business, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
};

/** A task of `client`, proposed under `purpose` and approved: held, unleased, in the queue. */
async function queuedOn(client: string, purpose: string, maximumMinor: number): Promise<Queued> {
  const made = await asPerson({ command: 'task.create', fields: { title: `work for ${purpose}` } });
  const taskId = String(made['recordId']);
  const placed = { recordId: taskId, expectedRevision: await revisionOf(taskId) };
  await asPerson({ command: 'task.set_party', ...placed, fields: { client } });
  const proposed = await asPerson({
    command: 'task.propose',
    recordId: taskId,
    expectedRevision: await revisionOf(taskId),
    purpose,
    maximumMinor,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  const decided = await asPerson({
    command: 'task.decide',
    gateId: proposed['gateId'],
    versionId: proposed['versionId'],
    decision: 'approve',
    note: 'approved so it is queued',
  });
  return { taskId, reservationId: String(decided['reservationId']) };
}

/** Another agent actor with a login of its own, as `agentWorld` installs its one. */
async function secondAgent(): Promise<typeof otherAgent> {
  const subject = `agent-${randomUUID()}`;
  await world.db.app.withBusiness(world.business, async (tx) => {
    const actorId = randomUUID();
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      world.business,
      actorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.business, randomUUID(), loginId, actorId, person.actorId],
    );
  });
  return async (body) =>
    (await executeAgentCommand(
      world.db.app,
      world.business,
      { provider: 'supabase', subject },
      undefined,
      body as never,
    )) as CommandResult;
}

const agentQueue = async (credential?: string): Promise<Queue> =>
  queueOf(await world.asAgent({ command: 'task.queue', operationId: randomUUID() }, credential));

/** Nothing of client B's queued work in the answer: its ids, its slug or its held amount. */
const showsNothingOfClientB = (queue: Queue): void => {
  const text = JSON.stringify(queue);
  expect(text).not.toContain(otherClient.reservationId);
  expect(text).not.toContain(otherClient.taskId);
  expect(text).not.toContain(CLIENT_B_SLUG);
  expect(queue.map((entry) => entry['heldMinor'])).not.toContain(CLIENT_B_HELD);
};

const showsBothClients = (queue: Queue): void => {
  expect(reservations(queue)).toEqual(
    expect.arrayContaining([sameClient.reservationId, otherClient.reservationId]),
  );
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('agentqueue', `agent-queue-${randomUUID().slice(0, 8)}`);
  person = await world.decider('delegating-person');
  await world.db.app.withBusiness(world.business, async (tx) => {
    // To make the two clients and place a task on each.
    await grantTo(tx, person, 'write', WHOLE_BUSINESS, false, 'record');
    await grantTo(tx, person, 'share');
  });
  const clientA = String(
    (await asPerson({ command: 'client.create', name: 'Harbourline' }))['clientId'],
  );
  const clientB = String(
    (await asPerson({ command: 'client.create', name: 'Bramble' }))['clientId'],
  );
  delegated = await queuedOn(clientA, `reply_for_client_a_${randomUUID().slice(0, 8)}`, 3_000);
  sameClient = await queuedOn(clientA, `chase_for_client_a_${randomUUID().slice(0, 8)}`, 2_000);
  otherClient = await queuedOn(clientB, CLIENT_B_SLUG, CLIENT_B_HELD);
  otherClientPicked = await queuedOn(clientB, `${CLIENT_B_SLUG}_second`, 1_500);
  otherAgent = await secondAgent();
}, 120_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('the agent work queue before a pickup', () => {
  it('shows the agent every client’s queued work before it picks anything up', async () => {
    const queue = queueOf(await world.asAgent(coldRead));
    expect(reservations(queue)).toEqual(
      expect.arrayContaining([
        delegated.reservationId,
        sameClient.reservationId,
        otherClient.reservationId,
      ]),
    );
  });
});

describe.skipIf(serverUrl === undefined)('the delegated agent’s own queue', () => {
  beforeAll(async () => {
    const pickup = { command: 'task.pickup', reservationId: delegated.reservationId };
    const picked = ok(await world.asAgent({ ...pickup, operationId: randomUUID() }), 'task.pickup');
    live = {
      credential: String(picked['credential']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
    };
  });

  it('never shows the delegated agent another client’s queued work, slug or held amount', async () => {
    showsNothingOfClientB(await agentQueue(live.credential));
  });

  it('narrows the same way when the agent leaves its credential off', async () => {
    showsNothingOfClientB(await agentQueue());
  });

  it('answers a repeat of its earlier queue read with the narrowed queue, not the stored one', async () => {
    showsNothingOfClientB(queueOf(await world.asAgent(coldRead, live.credential)));
    showsNothingOfClientB(queueOf(await world.asAgent(coldRead)));
  });

  it('still shows the delegated agent its own client’s other queued work', async () => {
    const queue = await agentQueue(live.credential);
    expect(reservations(queue)).toContain(sameClient.reservationId);
    const entry = queue.find((row) => row['reservationId'] === sameClient.reservationId);
    expect(entry?.['taskId']).toBe(sameClient.taskId);
    expect(entry?.['heldMinor']).toBe(2_000);
  });
});

describe.skipIf(serverUrl === undefined)('other readers while the delegation is live', () => {
  it('leaves another agent with no delegation reading every client’s queued work', async () => {
    showsBothClients(
      queueOf(await otherAgent({ command: 'task.queue', operationId: randomUUID() })),
    );
  });

  it('keeps client B out of the agent’s queue when another agent is delegated client B’s work', async () => {
    const pickup = { command: 'task.pickup', reservationId: otherClientPicked.reservationId };
    ok(await otherAgent({ ...pickup, operationId: randomUUID() }), 'task.pickup');
    // The second agent, delegated for client B, sees client B's work.
    const theirs = queueOf(await otherAgent({ command: 'task.queue', operationId: randomUUID() }));
    expect(reservations(theirs)).toContain(otherClient.reservationId);
    showsNothingOfClientB(await agentQueue(live.credential));
    showsNothingOfClientB(await agentQueue());
  });

  it('leaves the person’s own queue read whole', async () => {
    const read = await executeRead(world.db.app, world.business, person.presented, {
      read: 'task.queue',
    });
    if (isCommandRefusal(read)) throw new Error(`task.queue refused ${read.code}`);
    const queue = (read as unknown as { readonly queue: Queue }).queue;
    showsBothClients(queue);
    expect(JSON.stringify(queue)).toContain(CLIENT_B_SLUG);
  });

  it('shows every client’s queued work again once the agent hands the task back', async () => {
    const handback = { command: 'task.handback', leaseId: live.leaseId, fence: live.fence };
    const report = { outcome: 'completed', report: { wrote: 'a draft' } };
    ok(
      await world.asAgent({ ...handback, ...report, operationId: randomUUID() }, live.credential),
      'task.handback',
    );
    showsBothClients(await agentQueue());
  });
});

describe.skipIf(serverUrl === undefined)('a delegation for a task with no client', () => {
  let delegationId: string;

  beforeAll(async () => {
    // After the handback above, so nothing else of the agent's is live.
    const picked = await world.pickUp(person, 'internal work on no client');
    delegationId = String(picked.detail['delegationId']);
  });

  it('shows the agent no client’s queued work', async () => {
    const queue = await agentQueue();
    showsNothingOfClientB(queue);
    expect(reservations(queue)).not.toContain(sameClient.reservationId);
  });

  it('shows every client’s queued work again once that delegation is revoked', async () => {
    await world.revokeDelegation(delegationId);
    showsBothClients(await agentQueue());
  });
});
