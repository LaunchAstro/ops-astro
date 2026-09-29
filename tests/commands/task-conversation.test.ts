// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-5 on the command path, against a real database, for what the
// conversation already writes: a comment is `task:comment`'s and joins the
// audit chain; an agent comments to Internal only; and a client message
// reaches only that task's client while internal notes, and their count,
// never reach a client session (TR-S-B2-16, a seeded client person until
// invitations land in U35). Replies, edits, deletes and the signals are the
// ticket's server step.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertLogin, insertMapping, insertPerson } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-conversation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

const NOTE = `internal-canary-${randomUUID()}`;
const OTHER = `other-client-canary-${randomUUID()}`;

let world: AgentWorld;
let decider: Decider;
let reader: Member;
let clientPersonA: Member;
const ids: Record<string, string> = {};

const revision = async (recordId: string): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

const as = async (member: Member, body: Body) =>
  await executeCommand(world.db.app, world.business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

const must = async (member: Member, body: Body): Promise<string> => {
  const answer = await as(member, body);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return String(answer.recordId ?? '');
};

const comment = async (member: Member, recordId: string, audience: string, body: string) =>
  await as(member, {
    command: 'task.comment',
    recordId,
    expectedRevision: await revision(recordId),
    body,
    audience,
    commentType: audience === 'client' ? 'client' : 'note',
  });

/** A task on `client` with an internal note and a client message on it. */
const make = async (client: string, note: string, message: string): Promise<string> => {
  const recordId = await must(decider, { command: 'task.create', fields: { title: 'a task' } });
  await must(decider, {
    command: 'task.set_party',
    recordId,
    expectedRevision: await revision(recordId),
    fields: { client },
  });
  await comment(decider, recordId, 'internal', note);
  await comment(decider, recordId, 'client', message);
  return recordId;
};

/** One of a client's people: a login and no membership, on the client by a party-scoped read. */
const clientPerson = async (client: string): Promise<Member> =>
  await world.db.app.withBusiness(world.business, async (tx) => {
    const subject = `client-person-${randomUUID()}`;
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, decider.actorId);
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'party', id: client },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: decider.actorId,
    });
    if (!issued.ok) throw new Error(`clientPerson: refused ${issued.refusal.code}`);
    return { personId, actorId, presented: { provider: 'supabase', subject } } as Member;
  });

const commentsOf = async (recordId: string): Promise<number> => await world.commentsOn(recordId);

async function seed(): Promise<void> {
  world = await agentWorld('tcv', `conversation-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  reader = await enrol(world.db.app, world.business, 'reader');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'share');
    await grantTo(tx, decider, 'share', undefined, false, 'access');
    await grantTo(tx, reader, 'read');
  });
  const clientA = randomUUID();
  ids['a'] = await make(clientA, NOTE, 'a message for client A');
  ids['b'] = await make(randomUUID(), `${OTHER} note`, OTHER);
  clientPersonA = await clientPerson(clientA);
  await must(decider, {
    command: 'task.share_with_client',
    recordId: ids['a'],
    expectedRevision: await revision(ids['a'] ?? ''),
  });
}

beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-5 permissions and audit', () => {
  it('MP-4-5 task:comment refused: a reader without the grant writes nothing', async () => {
    const before = await commentsOf(ids['a'] ?? '');
    const answer = await comment(reader, ids['a'] ?? '', 'internal', 'not mine to say');
    expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
    expect(await commentsOf(ids['a'] ?? '')).toBe(before);
  });

  it('MP-4-5 audit read-back: a comment joins the audit chain as applied', async () => {
    const operationId = randomUUID();
    const answer = await as(decider, {
      command: 'task.comment',
      operationId,
      recordId: ids['a'],
      expectedRevision: await revision(ids['a'] ?? ''),
      body: 'read me back',
      audience: 'internal',
      commentType: 'note',
    });
    expect(isCommandRefusal(answer)).toBe(false);
    expect(await world.auditFor(operationId)).toStrictEqual([{ outcome: 'applied', code: null }]);
    const chain = await world.db.app.withBusiness(
      world.business,
      async (tx) => await verifyAuditChain(tx),
    );
    expect(chain.intact).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 agent client audience refused', () => {
  it('MP-4-5 agent client audience refused: Internal only, and a Client comment writes nothing', async () => {
    const picked = await world.pickUp(decider, 'the agent’s task');
    const before = await commentsOf(picked.taskId);
    const internal = await world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: picked.taskId,
        body: 'a team note',
        audience: 'internal',
      },
      picked.credential,
    );
    expect(isCommandRefusal(internal)).toBe(false);
    const client = await world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: picked.taskId,
        body: 'to the client',
        audience: 'client',
      },
      picked.credential,
    );
    expect(codeOf(client)).toBe('AUDIENCE_NOT_PERMITTED');
    expect(await commentsOf(picked.taskId)).toBe(before + 1);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-5 client audience', () => {
  it('a client message reaches only that task’s client; internal notes and their count never do', async () => {
    const own = await executeRead(world.db.app, world.business, clientPersonA.presented, {
      read: 'task.read',
      recordId: ids['a'],
    });
    if (isCommandRefusal(own) || !('sharedTask' in own)) {
      throw new Error(`client A did not get the shared view: ${JSON.stringify(own)}`);
    }
    const bodies = own.sharedTask.comments.map((row) => JSON.stringify(row));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('a message for client A');
    expect(JSON.stringify(own)).not.toContain(NOTE);
    const across = await executeRead(world.db.app, world.business, clientPersonA.presented, {
      read: 'task.read',
      recordId: ids['b'],
    });
    expect(isCommandRefusal(across) ? 'refused' : 'answered').toBe('refused');
    expect(JSON.stringify(across)).not.toContain(OTHER);
  });
});
