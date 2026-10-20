// SPDX-License-Identifier: AGPL-3.0-only
//
// Add client (#1735), against a real database: a client made by
// `client.create` as the Clients page sends it is named by its own business's
// `client.list` after reread, and pressing Add again under the same operation
// id returns that same client. Nothing of it crosses: another business's book
// never names it, and replaying its operation id there makes that business
// its own client; a person held to another client of the same business lists
// only theirs; another person replaying the owner's operation id is not handed
// the owner's client; and an agent acting for a person neither lists it nor
// makes one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-client-added-in-the-web-stays-in-its-business: DATABASE_URL is unset, so nothing below ran.',
  );
}

let world: AgentWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) {
    world = await agentWorld('cadd', `client-add-${randomUUID().slice(0, 8)}`);
  }
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

type Body = Readonly<Record<string, unknown>>;

/** A planted name: if any answer outside its business carries it, the test says so. */
const MARKER = `Northgate Plumbing ${randomUUID()}`;

/** `client.list` as `member` in `business`: the whole answer, and the names it gives. */
async function listAs(business: BusinessId, member: Member) {
  const answer = await executeRead(world.db.app, business, member.presented, {
    read: 'client.list',
  } as never);
  const body = JSON.stringify(answer);
  if (isCommandRefusal(answer) || !('clients' in answer)) return { body, names: null };
  const clients = answer.clients as readonly { clientId: string; name: string }[];
  return { body, names: clients.map((each) => each.name) };
}

/** `client.create` as the Clients page sends it: the name, under the given operation id. */
async function createAs(business: BusinessId, member: Member, name: string, operationId: string) {
  return await executeCommand(world.db.app, business, member.presented, 'api', {
    command: 'client.create',
    operationId,
    name,
  } as never);
}

const clientIdOf = (result: Awaited<ReturnType<typeof createAs>>): string => {
  if (isCommandRefusal(result)) throw new Error(`client.create refused ${result.code}`);
  return String((result.detail as Body)['clientId']);
};

interface Scene {
  readonly owner: Decider;
  readonly operationId: string;
  readonly clientId: string;
}

/** Another business: its book never names the client, and the same operation id there makes its own. */
async function crossBusiness({ operationId, clientId, owner }: Scene): Promise<void> {
  const bravo = (await insertBusiness(
    world.db.app,
    `cadd-b-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  const bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'read');
    await grantTo(tx, bravoOwner, 'write', WHOLE_BUSINESS, false, 'record');
  });
  const before = await listAs(bravo, bravoOwner);
  expect(before.names).toStrictEqual([]);
  expect(before.body).not.toContain(clientId);
  expect(before.body).not.toContain(MARKER);
  const replayed = await createAs(bravo, bravoOwner, MARKER, operationId);
  expect(JSON.stringify(replayed)).not.toContain(clientId);
  const bravoClient = clientIdOf(replayed);
  expect(bravoClient).not.toBe(clientId);
  // Alpha's book still holds its one client of that name, never bravo's.
  const alpha = await listAs(world.business, owner);
  expect(alpha.names?.filter((name) => name === MARKER)).toHaveLength(1);
  expect(alpha.body).not.toContain(bravoClient);
}

/** Another client in the same business: a person held to it lists it alone. */
async function crossClient({ owner, clientId }: Scene): Promise<void> {
  const other = clientIdOf(
    await createAs(world.business, owner, `Coral Coast Yoga ${randomUUID()}`, randomUUID()),
  );
  const heldToOther = await enrol(world.db.app, world.business, 'held-to-other');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, heldToOther, 'read', { kind: 'party', id: other });
  });
  const listed = await listAs(world.business, heldToOther);
  expect(listed.names).toHaveLength(1);
  expect(listed.body).toContain(other);
  expect(listed.body).not.toContain(clientId);
  expect(listed.body).not.toContain(MARKER);
}

/** Another person: replaying the owner's operation id is their own attempt, never the owner's client. */
async function crossPerson({ operationId, clientId }: Scene): Promise<void> {
  const writer = await enrol(world.db.app, world.business, 'second-writer');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, writer, 'write', WHOLE_BUSINESS, false, 'record');
  });
  const replayed = await createAs(world.business, writer, MARKER, operationId);
  expect(isCommandRefusal(replayed) ? replayed.code : 'applied').toBe('CLIENT_NAME_TAKEN');
  expect(JSON.stringify(replayed)).not.toContain(clientId);
}

/** An agent acting for the owner: it lists no client and makes none, under the owner's operation id or its own. */
async function crossDelegation({ owner, operationId, clientId }: Scene): Promise<void> {
  const picked = await world.pickUp(owner, 'delegated');
  const listed = await world.asAgent(
    { command: 'client.list', operationId: randomUUID() },
    picked.credential,
  );
  expect(JSON.stringify(listed)).not.toContain(clientId);
  expect(JSON.stringify(listed)).not.toContain(MARKER);
  for (const attempt of [operationId, randomUUID()]) {
    // eslint-disable-next-line no-await-in-loop -- one attempt at a time
    const made = await world.asAgent(
      { command: 'client.create', operationId: attempt, name: `${MARKER} again` },
      picked.credential,
    );
    expect(codeOf(made)).not.toBe('not-a-refusal');
    expect(JSON.stringify(made)).not.toContain(clientId);
  }
}

describe.skipIf(serverUrl === undefined)('Add client stays in its business', () => {
  it('a client added is listed after reread, the same operation id returns it, and nothing of it crosses', async () => {
    const owner = await world.decider('cadd-owner');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, owner, 'write', WHOLE_BUSINESS, false, 'record');
      await grantTo(tx, owner, 'share');
    });
    const operationId = randomUUID();
    const clientId = clientIdOf(await createAs(world.business, owner, MARKER, operationId));
    expect((await listAs(world.business, owner)).names).toContain(MARKER);
    // Add pressed again after a lost answer: the same client, and still one of it.
    expect(clientIdOf(await createAs(world.business, owner, MARKER, operationId))).toBe(clientId);
    expect(
      (await listAs(world.business, owner)).names?.filter((name) => name === MARKER),
    ).toHaveLength(1);

    const scene = { owner, operationId, clientId };
    await crossBusiness(scene);
    await crossClient(scene);
    await crossPerson(scene);
    await crossDelegation(scene);
  });
});
