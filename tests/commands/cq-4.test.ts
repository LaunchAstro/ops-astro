// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-4: the command layer moved into its own package, and every business,
// client and permission check on the command and read paths came with it.
//
// Each case goes through the command package's one entry, `index.ts`, the way
// the API does. The mutation case loads a copy of the three packages with the
// grant check at that package's boundary removed, and shows the parity case
// then goes red: a parity case that passed either way would prove nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as commands from '../../packages/core-commands/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { createSourceMutant, type SourceMutant } from '../support/source-mutant.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
type Entry = Pick<typeof commands, 'executeCommand' | 'executeRead' | 'isCommandRefusal'>;
type Command = Parameters<typeof commands.executeCommand>[4];
type Read = Parameters<typeof commands.executeRead>[3];
type Task = { readonly id: string; readonly title: string; readonly client: Member };
type Party = { readonly id: BusinessId; readonly member: Member; readonly tasks: Task[] };

const TREES = [
  'packages/core-records/src',
  'packages/core-runtime/src',
  'packages/core-commands/src',
];
/** The grant check the person path runs before any handler, at the command package's boundary. */
const GRANT_CHECK = {
  file: 'packages/core-commands/src/commands/prepare.ts',
  from: '  if (!authorised.ok) return refused(fromReasoned(authorised.refusal));',
  to: '  void authorised;',
  trees: TREES,
};

/** The codes a missing grant and an agent outside its delegation answer with, before the move. */
const PERSON_CODES = ['SCOPE_NOT_GRANTED', 'SCOPE_NOT_GRANTED', 'SCOPE_NOT_GRANTED'];
const AGENT_CODES = ['DELEGATION_EXCLUDES_OPERATION', 'DELEGATION_OUT_OF_PURPOSE'];

const codeOfResult = (entry: Entry, result: unknown): string =>
  entry.isCommandRefusal(result as never) ? String((result as { code: string }).code) : 'ok';
const ghost = (task: Task): Task => ({ ...task, id: randomUUID() });

async function logged<T>(run: () => Promise<T>): Promise<[T, string]> {
  const lines: unknown[] = [];
  const push = (...parts: unknown[]) => lines.push(...parts) > 0;
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const spies = [
    ...levels.map((level) => vi.spyOn(console, level).mockImplementation(push)),
    ...[process.stdout, process.stderr].map((s) => vi.spyOn(s, 'write').mockImplementation(push)),
  ];
  const result = await run().finally(() => spies.forEach((spy) => spy.mockRestore()));
  return [result, lines.map(String).join('\n')];
}

describe.skipIf(serverUrl === undefined)('CQ-4 the command package entry', () => {
  let db: FreshDatabase;
  let bravo: Party;
  let charlie: Party;
  let mutant: SourceMutant;
  let mutated: Entry;

  const command = async (entry: Entry, business: BusinessId, who: Member, body: object) =>
    await entry.executeCommand(db.app, business, who.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as Command);
  const read = async (entry: Entry, business: BusinessId, who: Member, body: object) =>
    await entry.executeRead(db.app, business, who.presented, body as Read);

  /** A business whose member holds write and read, and two clients one read grant each. */
  async function party(key: string): Promise<Party> {
    const id = (await insertBusiness(db.app, key)) as BusinessId;
    await installSpine(db.app, id);
    const member = await enrol(db.app, id, `${key}-member`);
    await db.app.withBusiness(id, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'read');
    });
    const tasks: Task[] = [];
    for (const n of [1, 2]) {
      const title = `cq4-${key}-${String(n)}-${randomUUID()}`;
      // eslint-disable-next-line no-await-in-loop
      const made = await command(commands, id, member, {
        command: 'task.create',
        fields: { title },
      });
      if (commands.isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
      // eslint-disable-next-line no-await-in-loop
      const client = await enrol(db.app, id, `${key}-client-${String(n)}`);
      const recordId = String(made.recordId);
      // eslint-disable-next-line no-await-in-loop
      await db.app.withBusiness(id, async (tx) => {
        await grantTo(tx, client, 'read', { kind: 'record', id: recordId });
      });
      tasks.push({ id: recordId, title, client });
    }
    return { id, member, tasks };
  }

  /** Read, list, count, export and change `task`, as `who`, through the entry. */
  const reach = async (p: Party, task: Task, who: Member) =>
    JSON.stringify(
      await Promise.all([
        read(commands, p.id, who, { read: 'task.read', recordId: task.id }),
        read(commands, p.id, who, { read: 'task.board', board: null }),
        read(commands, p.id, who, { read: 'task.queue' }),
        read(commands, p.id, who, { read: 'person.list' }),
        command(commands, p.id, who, {
          command: 'task.update',
          recordId: task.id,
          expectedRevision: 1,
          fields: { title: 'cq4-changed' },
        }),
      ]),
    );
  const records = async () =>
    JSON.stringify(await db.admin.execute('select x::text from public.records x order by id'));

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'cq4' });
    bravo = await party('bravo');
    charlie = await party('charlie');
    mutant = createSourceMutant(GRANT_CHECK);
    mutated = await mutant.load<Entry>('packages/core-commands/src/index.ts');
  }, 120_000);

  afterAll(async () => {
    mutant?.dispose();
    await db?.drop();
  });

  it('CQ-4 isolation: two businesses, two clients, one grant each, through the command package entry', async () => {
    const before = await records();
    for (const p of [bravo, charlie]) {
      const [one, two] = p.tasks as [Task, Task];
      // eslint-disable-next-line no-await-in-loop
      const [own, other, none] = await Promise.all([
        read(commands, p.id, one.client, { read: 'task.read', recordId: one.id }),
        reach(p, two, one.client),
        reach(p, ghost(two), one.client),
      ]);
      expect(JSON.stringify(own)).toContain(one.title);
      // Another client's task is answered as a made-up id is, and nothing names it.
      expect(other.replaceAll(two.id, 'ID')).toBe(none.replaceAll(/[0-9a-f-]{36}/gu, 'ID'));
      for (const leaked of [two.title, two.id, two.client.personId])
        expect(other).not.toContain(leaked);
    }
    // Across businesses: neither business's member or clients reach the other's rows.
    for (const [from, to] of [
      [bravo, charlie],
      [charlie, bravo],
    ] as const) {
      for (const who of [from.member, ...from.tasks.map((t) => t.client)]) {
        for (const task of to.tasks) {
          // eslint-disable-next-line no-await-in-loop
          const [inTheirs, inOwn] = await Promise.all([
            reach(to, task, who),
            reach(from, task, who),
          ]);
          expect(`${inTheirs}${inOwn}`).not.toContain(task.title);
          expect(inTheirs).not.toMatch(/"ok":true|"recordId"/u);
        }
      }
    }
    expect(await records()).toBe(before);
  });

  it('CQ-4 permission parity: a missing grant answers the codes it answered before the move', async () => {
    const codes = async (entry: Entry) => {
      const [one] = bravo.tasks as [Task];
      const stranger = await enrol(db.app, bravo.id, `stranger-${randomUUID()}`);
      return [
        codeOfResult(
          entry,
          await command(entry, bravo.id, stranger, {
            command: 'task.create',
            fields: { title: 'cq4-no-grant' },
          }),
        ),
        codeOfResult(
          entry,
          await command(entry, bravo.id, one.client, {
            command: 'task.create',
            fields: { title: 'cq4-read-only' },
          }),
        ),
        codeOfResult(
          entry,
          await command(entry, bravo.id, one.client, {
            command: 'task.update',
            recordId: one.id,
            expectedRevision: 1,
            fields: { title: 'cq4-read-only' },
          }),
        ),
      ];
    };
    expect(await codes(commands)).toStrictEqual(PERSON_CODES);
    // The mutation: the same calls with the boundary's grant check removed are not refused so.
    expect(await codes(mutated)).not.toStrictEqual(PERSON_CODES);
  });

  it('CQ-4 permission parity: an agent outside its delegation answers the codes it answered before', async () => {
    let world: AgentWorld | undefined;
    try {
      world = await agentWorld('cq4a', 'cq4-agent');
      const decider = await world.decider('cq4-decider');
      const made = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'cq4 sibling' },
      });
      const sibling = String((made as { recordId: string }).recordId);
      const bare = await world.asAgent({
        command: 'task.read',
        operationId: randomUUID(),
        recordId: sibling,
      });
      const { credential } = await world.pickUp(decider, 'cq4 the one task');
      const outside = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: sibling },
        credential,
      );
      expect([codeOf(bare), codeOf(outside)]).toStrictEqual(AGENT_CODES);
    } finally {
      await world?.drop();
    }
  }, 120_000);

  it('CQ-4 canary: a planted canary secret in a refused request reaches no log, error or trace', async () => {
    const canary = `GATE_SIGNING_SECRET=cq4-canary-${randomUUID()}`;
    const [one, two] = bravo.tasks as [Task, Task];
    const stranger = await enrol(db.app, bravo.id, `canary-${randomUUID()}`);
    const [answers, log] = await logged(async () => [
      await command(commands, bravo.id, stranger, {
        command: 'task.create',
        fields: { title: canary },
      }),
      await command(commands, bravo.id, one.client, {
        command: 'task.update',
        recordId: two.id,
        expectedRevision: 1,
        fields: { title: canary },
      }),
      await command(commands, charlie.id, bravo.member, {
        command: 'task.create',
        fields: { title: canary },
      }),
      await read(commands, bravo.id, stranger, { read: 'task.read', recordId: canary }),
    ]);
    expect(answers.map((answer) => codeOfResult(commands, answer))).not.toContain('ok');
    const audit = await db.admin.execute('select x::text from public.audit_events x');
    const traces = JSON.stringify(db.log.entries);
    for (const seen of [JSON.stringify(answers), log, traces, JSON.stringify(audit)]) {
      expect(seen).not.toContain(canary);
    }
  });
});
