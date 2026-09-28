// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-5: one refusal shape at every layer, and what reaches the wire unchanged.
//
// The static cases read the source: the register declares the only shape with
// a code and a refusal flag, and the converters between the old shapes are
// gone with nothing re-spelling a refusal in their place. The database cases
// show grants, delegations and the isolation rules answer as they did.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as commands from '../../packages/core-commands/src/index.ts';
import { checkAuthority, revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
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

const LAYERS = ['packages', 'apps/api'];
const sourcesOf = (roots: readonly string[]): string[] =>
  roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/u.test(file) && !file.includes('node_modules'))
      .map((file) => `${root}/${file}`),
  );

/** A `refused` or a `code` among an object's own members, shorthand or typed. */
const OWN_MEMBER = {
  refused: /(^|[\s;,{])(readonly\s+)?refused\??\s*[:,;]/u,
  code: /(^|[\s;,{])(readonly\s+)?code\??\s*[:,;]/u,
};

/**
 * Every brace block in `text` whose own members include both `refused` and
 * `code`: an interface, an object type or an object literal, so a second
 * declared shape and a refusal built outside the constructor are both found.
 * Named by the `interface` or `type` it opens, or `literal`.
 */
function refusalShapes(file: string, text: string): string[] {
  const source = text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
  const found: string[] = [];
  const open: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') open.push(i);
    if (source[i] !== '}') continue;
    const start = open.pop() ?? 0;
    let own = source.slice(start + 1, i);
    while (/\{[^{}]*\}/u.test(own)) own = own.replaceAll(/\{[^{}]*\}/gu, '');
    if (OWN_MEMBER.refused.test(own) && OWN_MEMBER.code.test(`${own};`)) {
      const opener = /(?:interface|type)\s+(\w+)[^{;]*$/u.exec(source.slice(0, start))?.[1];
      found.push(`${file}:${opener ?? 'literal'}`);
    }
  }
  return found;
}

describe('CQ-5 the source', () => {
  it('CQ-5 one refusal type: the register declares the only shape with a code and a refusal flag', () => {
    const shapes = sourcesOf(LAYERS)
      .flatMap((f) => refusalShapes(f, readFileSync(f, 'utf8')))
      .toSorted();
    // The HTTP door, copying the four wire fields in order; the declaration;
    // and the one constructor's own return.
    expect(shapes).toStrictEqual([
      'apps/api/app.ts:literal',
      'packages/core-records/src/register.ts:CommandRefusal',
      'packages/core-records/src/register.ts:literal',
    ]);
    // The check sees a second shape and a hand-built refusal, so it is not blind.
    const planted =
      'type Second = { readonly refused: true; readonly code: string };\n' +
      "const made = { refused: true, code: 'NOT_FOUND', names: [], fixes: [] };";
    expect(refusalShapes('planted.ts', planted)).toStrictEqual([
      'planted.ts:Second',
      'planted.ts:literal',
    ]);
  });

  it('Sol proof, criterion 5: the web declares no second refusal shape', () => {
    const declarations = sourcesOf(['apps/web', 'apps/cli'])
      .flatMap((file) => refusalShapes(file, readFileSync(file, 'utf8')))
      .filter((shape) => !shape.endsWith(':literal'))
      .toSorted();
    expect(declarations).toStrictEqual([]);
  });

  it('Sol proof, criterion 5: composed refusal declaration fails uniqueness check', () => {
    const planted =
      'export type SplitRefusal = { readonly refused: true } & { readonly code: string };';
    expect(refusalShapes('planted.ts', planted)).toStrictEqual(['planted.ts:SplitRefusal']);
  });

  it('CQ-5 converters gone: fromRecords, fromIdentity, fromAgentIdentity and fromReasoned, and nothing replaces them', () => {
    const files = sourcesOf([...LAYERS, 'apps/web', 'apps/cli', 'scripts']);
    const texts = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
    const named = /\bfrom(?:Records|Identity|AgentIdentity|Reasoned|PresetPlan)\b/u;
    // A replacement re-spells another refusal: `refuseCommand(x.code, ...)`,
    // or rebuilds one under a constant code from its parts:
    // `refuseCommand('SCOPE_NOT_GRANTED', [], x.refusal.fixes)`.
    const respelled = /refuseCommand\(\s*[\w.]+\.code\b/u;
    const rebuilt = /refuseCommand\((?:[^()]|\([^()]*\))*?\.refusal\.(?:code|names|fixes)\b/u;
    const converts = (t: string) => named.test(t) || respelled.test(t) || rebuilt.test(t);
    expect(texts.filter(([, t]) => converts(t)).map(([f]) => f)).toEqual([]);
    // The rebuild CQ-5's first head had in `shares.ts` is caught.
    const planted = "refusal: refuseCommand('SCOPE_NOT_GRANTED', [], authorised.refusal.fixes)";
    expect(converts(planted)).toBe(true);
  });

  it('Sol proof, criterion 6: share authority denial is not rebuilt', () => {
    const source = readFileSync('packages/core-records/src/authority/shares.ts', 'utf8');
    const rebuilt =
      /refusal:\s*refuseCommand\(\s*'SCOPE_NOT_GRANTED',\s*\[\],\s*authorised\.refusal\.fixes\)/u;
    expect(rebuilt.test(source)).toBe(false);
  });
});

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

  it('Sol proof, criterion 4: client isolation exercises the external shared view', async () => {
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
    const decision = await db.app.withBusiness(charlie.id, async (tx) =>
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
