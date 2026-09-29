// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-5: one refusal shape at every layer, and what reaches the wire unchanged.
//
// The database cases show grants, delegations and the isolation rules answer
// as they did. The static cases, which read the source, are in
// cq-5-source.test.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as commands from '../../packages/core-commands/src/index.ts';
import { checkAuthority, revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { agentWorld, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
type Command = Parameters<typeof commands.executeCommand>[4];
type Read = Parameters<typeof commands.executeRead>[3];
type Task = { readonly id: string; readonly title: string; readonly client: Member };
type Party = { readonly id: BusinessId; readonly member: Member; readonly tasks: Task[] };

describe.skipIf(serverUrl === undefined)('CQ-5 refusals through the command entry', () => {
  let db: FreshDatabase;
  let bravo: Party;
  let charlie: Party;

  const command = async (business: BusinessId, who: Member, body: object) =>
    await commands.executeCommand(db.app, business, who.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as Command);
  const read = async (business: BusinessId, who: Member, body: object) =>
    await commands.executeRead(db.app, business, who.presented, body as Read);

  /**
   * A client outside the business: a login and a person with no membership,
   * who stands on the one task the member shares with them (the external view).
   */
  async function client(id: BusinessId, member: Member, key: string, recordId: string) {
    const subject = `${key}-${randomUUID()}`;
    return await db.app.withBusiness(id, async (tx): Promise<Member> => {
      const personId = await insertPerson(tx, key);
      const actorId = await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, member.actorId);
      const sharer = { personId: member.personId, actorId: member.actorId };
      const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
      if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);
      return { personId, actorId, presented: { provider: 'supabase', subject } };
    });
  }

  /** A business whose member holds write, read and share, and two external clients one share each. */
  async function party(key: string): Promise<Party> {
    const id = (await insertBusiness(db.app, key)) as BusinessId;
    await installSpine(db.app, id);
    const member = await enrol(db.app, id, `${key}-member`);
    await db.app.withBusiness(id, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'read');
      await grantTo(tx, member, 'share');
    });
    const tasks: Task[] = [];
    for (const n of [1, 2]) {
      const title = `cq5-${key}-${String(n)}-${randomUUID()}`;
      // eslint-disable-next-line no-await-in-loop
      const made = await command(id, member, { command: 'task.create', fields: { title } });
      if (commands.isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
      const recordId = String(made.recordId);
      // eslint-disable-next-line no-await-in-loop
      const shared = await client(id, member, `${key}-client-${String(n)}`, recordId);
      tasks.push({ id: recordId, title, client: shared });
    }
    return { id, member, tasks };
  }

  /** Read, list, count and change `task`, as `who`, through the entry. */
  const reach = async (p: Party, task: Task, who: Member) =>
    JSON.stringify(
      await Promise.all([
        read(p.id, who, { read: 'task.read', recordId: task.id }),
        read(p.id, who, { read: 'task.board', board: null }),
        read(p.id, who, { read: 'task.queue' }),
        command(p.id, who, {
          command: 'task.update',
          recordId: task.id,
          expectedRevision: 1,
          fields: { title: 'cq5-changed' },
        }),
      ]),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'cq5' });
    bravo = await party('bravo');
    charlie = await party('charlie');
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('CQ-5 isolation: business to business, client to client and person to person, no refusal names another', async () => {
    for (const p of [bravo, charlie]) {
      const [one, two] = p.tasks as [Task, Task];
      const ghost = { ...two, id: randomUUID() };
      // Person to person: a member holding no grant is answered as for a made-up id.
      // eslint-disable-next-line no-await-in-loop
      const stranger = await enrol(db.app, p.id, `stranger-${randomUUID()}`);
      // eslint-disable-next-line no-await-in-loop
      const [theirs, nobody] = await Promise.all([
        reach(p, one, stranger),
        reach(p, ghost, stranger),
      ]);
      expect(theirs.replaceAll(one.id, 'ID')).toBe(nobody.replaceAll(ghost.id, 'ID'));
      for (const leaked of [one.title, one.client.personId, p.member.personId])
        expect(theirs).not.toContain(leaked);
      // Client to client, across the external boundary: each client reads its
      // own task through the shared view, and another client's task is
      // answered as a made-up id is.
      // eslint-disable-next-line no-await-in-loop
      const own = await read(p.id, one.client, { read: 'task.read', recordId: one.id });
      expect(own).toHaveProperty('sharedTask');
      expect(JSON.stringify(own)).toContain(one.title);
      // eslint-disable-next-line no-await-in-loop
      const [other, none] = await Promise.all([
        reach(p, two, one.client),
        reach(p, ghost, one.client),
      ]);
      expect(other.replaceAll(two.id, 'ID')).toBe(none.replaceAll(ghost.id, 'ID'));
      for (const leaked of [two.title, two.id, two.client.personId])
        expect(other).not.toContain(leaked);
    }
    for (const [from, to] of [
      [bravo, charlie],
      [charlie, bravo],
    ] as const) {
      for (const who of [from.member, ...from.tasks.map((t) => t.client)]) {
        for (const task of to.tasks) {
          // eslint-disable-next-line no-await-in-loop
          const answers = `${await reach(to, task, who)}${await reach(from, task, who)}`;
          expect(answers).not.toContain(task.title);
        }
      }
    }
  });

  it('client isolation exercises the external shared view', async () => {
    const [task] = bravo.tasks as [Task];
    const answer = await read(bravo.id, task.client, { read: 'task.read', recordId: task.id });
    expect(answer).toHaveProperty('sharedTask');
    expect(answer).not.toHaveProperty('task');
  });

  it('CQ-5 grants: a cross-business grant is refused, in the one shape', async () => {
    const holder = bravo.member;
    const subjects = [
      { kind: 'person', id: holder.personId },
      { kind: 'actor', id: holder.actorId },
    ] as const;
    const decision = await db.app.withBusiness(charlie.id, (tx) =>
      checkAuthority(tx, subjects, {
        collection: 'task',
        action: 'write',
        scope: { kind: 'business', id: null },
      }),
    );
    expect(decision).toStrictEqual({
      ok: false,
      refusal: {
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
        names: [],
        fixes: ['no live grant covers it', 'ask a holder who may delegate'],
      },
    });
  });

  it('CQ-5 delegations: a revoked delegation is refused, in the one shape', async () => {
    let world: AgentWorld | undefined;
    try {
      world = await agentWorld('cq5a', 'cq5-agent');
      const decider = await world.decider('cq5-decider');
      const { credential, taskId } = await world.pickUp(decider, 'cq5 the one task');
      const live = await world.db.admin.execute<{ readonly id: string }>(
        'select id from public.delegations where revoked_at is null',
      );
      await world.db.app.withBusiness(world.business, async (tx) => {
        for (const row of live) await revokeDelegation(tx, row.id); // eslint-disable-line no-await-in-loop
      });
      const refused = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: taskId },
        credential,
      );
      expect(JSON.stringify(refused)).toBe(
        '{"refused":true,"code":"DELEGATION_NOT_LIVE","names":[],"fixes":["no live delegation answers to that credential","ask the authorising person for a current delegation"]}',
      );
    } finally {
      await world?.drop();
    }
  }, 120_000);

  it('CQ-5 owner check: editing a task someone else changed first reads exactly as before', async () => {
    const [task] = bravo.tasks as [Task];
    const edit = { command: 'task.update', recordId: task.id, expectedRevision: 1 };
    const first = await command(bravo.id, bravo.member, { ...edit, fields: { title: 'cq5-a' } });
    expect(commands.isCommandRefusal(first)).toBe(false);
    const second = await command(bravo.id, bravo.member, { ...edit, fields: { title: 'cq5-b' } });
    expect(JSON.stringify(second)).toBe(STALE_EDIT);
  });
});

/** The stale-edit refusal as the head before CQ-5 answered it, byte for byte. */
const STALE_EDIT = JSON.stringify({
  refused: true,
  code: 'VERSION_STALE',
  names: ['revision=2'],
  fixes: [
    'Read the record and send the revision you are writing against as expected_revision.',
    'A write against a stale revision is refused, never merged.',
  ],
});
