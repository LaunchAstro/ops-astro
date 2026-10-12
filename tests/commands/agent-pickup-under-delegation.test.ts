// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's pickup while it works one client's task.
//
// While an agent holds a live delegation it is working for that task's
// client, and its `task.queue` shows that client's work only. Its
// `task.pickup` keeps to the same reach: a reservation of another client's
// task, even one whose id the agent kept from a queue read before its first
// delegation, is answered as one that is not claimable, naming nothing of that
// client. Its own client's other work it still picks up, and once it hands
// its task back it picks up any client's work again.
//
// The blocks run in file order over one world: the pickup in the second
// block is the delegation the third reads under, and its handback ends it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld, type Decider } from './agent-fixture.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('agent-pickup-under-delegation: DATABASE_URL is unset, so nothing here ran.');
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
/** Client A's task the agent picks up. */
let delegated: Queued;
/** Client A's other queued work. */
let sameClient: Queued;
/** Client B's queued work, whose id the agent keeps from its first queue read. */
let otherClient: Queued;
/** More of client B's work, which a delegation for client B would bring into the queue. */
let otherClientMore: Queued;
/** The delegation for client A's task, while it is live. */
let live: { readonly credential: string; readonly leaseId: string; readonly fence: number };

const ok = (result: CommandResult, what: string): Record<string, unknown> => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

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

const agentQueue = async (credential?: string): Promise<Queue> => {
  const answer = await world.asAgent(
    { command: 'task.queue', operationId: randomUUID() },
    credential,
  );
  expect(isCommandRefusal(answer)).toBe(false);
  return detailOf(answer)['queue'] as Queue;
};

const reservations = (queue: Queue): unknown[] => queue.map((entry) => entry['reservationId']);

const pickUp = async (reservationId: string, credential?: string): Promise<CommandResult> =>
  await world.asAgent(
    { command: 'task.pickup', operationId: randomUUID(), reservationId },
    credential,
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('agentpickup', `agent-pickup-${randomUUID().slice(0, 8)}`);
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
  otherClientMore = await queuedOn(clientB, `${CLIENT_B_SLUG}_second`, 1_500);
}, 120_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('the agent before its first delegation', () => {
  it('learns every client’s reservation from its queue', async () => {
    expect(reservations(await agentQueue())).toEqual(
      expect.arrayContaining([delegated.reservationId, otherClient.reservationId]),
    );
  });
});

describe.skipIf(serverUrl === undefined)('the delegated agent’s pickup', () => {
  beforeAll(async () => {
    const picked = ok(await pickUp(delegated.reservationId), 'task.pickup');
    live = {
      credential: String(picked['credential']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
    };
  });

  it('refuses another client’s reservation the agent learned before, naming nothing of that client', async () => {
    for (const credential of [live.credential, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await pickUp(otherClient.reservationId, credential);
      expect(codeOf(answer)).toBe('RESERVATION_NOT_CLAIMABLE');
      const text = JSON.stringify(answer);
      expect(text).not.toContain(otherClient.taskId);
      expect(text).not.toContain(CLIENT_B_SLUG);
      expect(text).not.toContain(String(CLIENT_B_HELD));
    }
  });

  it('keeps the agent’s queue to its own client after the refused pickup', async () => {
    const queue = await agentQueue(live.credential);
    expect(reservations(queue)).toContain(sameClient.reservationId);
    expect(reservations(queue)).not.toContain(otherClient.reservationId);
    expect(reservations(queue)).not.toContain(otherClientMore.reservationId);
    expect(JSON.stringify(queue)).not.toContain(CLIENT_B_SLUG);
  });

  it('still picks up its own client’s other queued work', async () => {
    const picked = ok(await pickUp(sameClient.reservationId, live.credential), 'task.pickup');
    expect(picked['taskId']).toBe(sameClient.taskId);
    const handback = {
      command: 'task.handback',
      leaseId: picked['leaseId'],
      fence: picked['fence'],
    };
    const report = { outcome: 'completed', report: { wrote: 'a chaser' } };
    ok(
      await world.asAgent(
        { ...handback, ...report, operationId: randomUUID() },
        String(picked['credential']),
      ),
      'task.handback',
    );
  });
});

describe.skipIf(serverUrl === undefined)('the agent after its handback', () => {
  it('picks up another client’s work once it holds no live delegation', async () => {
    const handback = { command: 'task.handback', leaseId: live.leaseId, fence: live.fence };
    const report = { outcome: 'completed', report: { wrote: 'a draft' } };
    ok(
      await world.asAgent({ ...handback, ...report, operationId: randomUUID() }, live.credential),
      'task.handback',
    );
    const picked = ok(await pickUp(otherClient.reservationId), 'task.pickup');
    expect(picked['taskId']).toBe(otherClient.taskId);
  });
});
