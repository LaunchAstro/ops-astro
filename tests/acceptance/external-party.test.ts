// SPDX-License-Identifier: AGPL-3.0-only
//
// R4 over HTTP: a real external party reads its shared record, and nothing
// else (ledger I01 R4 and I09; minimum contract 8.1 R4 and 8.2 case 7).
//
// The party is `enrolExternal`'s: a person of alpha with a login, an acting
// identity and no membership. The share is `shareRecord`'s, the owning
// interface, issued by the admin under her own `share` grant; no fixture row
// stands in for it. Everything asserted is the body the real Hono app answers,
// not a rendering of it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { createPositiveBody } from './role-case-bodies.ts';
import {
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Answer,
  type Caller,
  type World,
} from './world.ts';

const TITLE = 'Quarterly retainer: draft for review';
const DESCRIPTION = 'internal: client is behind on two invoices';
const TEAM_NOTE = 'team only: do not tell the client about the margin';
const CLIENT_NOTE = 'Hello, the draft is ready for your review.';
const SIBLING_TITLE = 'Sibling task the client must never learn about';

describe.skipIf(serverUrl === undefined)('R4: the external party over HTTP', () => {
  let world: World;
  let ext: Caller;
  let shared: string;
  let sibling: string;

  const as = async (who: Caller, name: CommandName, body: Record<string, unknown>) =>
    await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

  const revisionOf = async (recordId: string): Promise<number> => {
    const read = await as(world.ada, 'task.read', { recordId });
    return Number((read.body['task'] as Record<string, unknown>)['revision']);
  };

  const share = async (sharer: Caller, recordId: string) =>
    await world.db.app.withBusiness(world.alpha, (tx) =>
      shareRecord(
        tx,
        { personId: sharer.personId as string, actorId: sharer.actorId as string },
        { collection: 'task', recordId, personId: ext.personId as string },
      ),
    );

  beforeAll(async () => {
    world = await createWorld('r4_external');
    ext = await enrolExternal(world);

    const made = await as(world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: TITLE, description: DESCRIPTION },
    });
    expect(made.code).toBe('ok');
    shared = String(made.body['recordId']);
    for (const comment of [
      { body: TEAM_NOTE, audience: 'internal' },
      { body: CLIENT_NOTE, audience: 'client', commentType: 'client' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- the revision moves with each one
      const expectedRevision = await revisionOf(shared);
      // eslint-disable-next-line no-await-in-loop
      const written = await as(world.ada, 'task.comment', {
        operationId: randomUUID(),
        recordId: shared,
        expectedRevision,
        ...comment,
      });
      expect(written.code).toBe('ok');
    }
    const other = await as(world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: SIBLING_TITLE },
    });
    sibling = String(other.body['recordId']);
  });

  afterAll(async () => {
    await world?.close();
  });

  it('item 1: the login is refused until a share exists, and resolves once one does', async () => {
    const before = await as(ext, 'task.read', { recordId: shared });
    expect(before.code).toBe('AUTH_NO_MEMBERSHIP');

    // A member who may read but not share cannot mint one.
    const refused = await share(world.mia, shared);
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'SCOPE_NOT_GRANTED' } });

    const issued = await share(world.ada, shared);
    expect(issued.ok).toBe(true);
    const again = await share(world.ada, shared);
    expect(again).toStrictEqual(issued);

    const rows = await world.db.app.withBusiness(world.alpha, (tx) =>
      tx.query<Record<string, unknown>>(
        `select subject_kind, scope_kind, scope_id, collection, action, granted_by_actor_id
           from grants where subject_id = $1 and revoked_at is null`,
        [ext.personId],
      ),
    );
    expect(rows).toEqual([
      {
        subject_kind: 'person',
        scope_kind: 'record',
        scope_id: shared,
        collection: 'task',
        action: 'read',
        granted_by_actor_id: world.ada.actorId,
      },
    ]);
  });

  it('item 2: task.read on the shared record is the shared fields and client comments only', async () => {
    const read = await as(ext, 'task.read', { recordId: shared });
    expect(read.status).toBe(200);
    const text = JSON.stringify(read.body);
    console.log(`R4 task.read body: ${text}`);

    const task = read.body['sharedTask'] as Record<string, unknown>;
    expect(read.body['task']).toBeUndefined();
    // Nathan's I09 ruling (OWNER-CARD section 6): a shared task shows the
    // client its title and its status. The status is the state's label, the
    // word the admin's own read shows, not the identifier of a state record
    // the client cannot read.
    const admin = (await as(world.ada, 'task.read', { recordId: shared })).body['task'] as {
      readonly revision: number;
      readonly state: { readonly id: string; readonly label: string };
    };
    expect(admin.state.label).not.toBe('');
    expect(task).toStrictEqual({
      id: shared,
      // The record's version, which a permitted client comment needs (R2-AUTHORITY-36).
      revision: admin.revision,
      fields: { title: TITLE, state: admin.state.label },
      comments: [expect.objectContaining({ audience: 'client', body: CLIENT_NOTE })],
    });
    expect(text).not.toContain(admin.state.id);
    for (const secret of [DESCRIPTION, TEAM_NOTE, SIBLING_TITLE]) {
      expect(text).not.toContain(secret);
    }

    // The control: the admin's read of the same record carries all of it.
    const control = JSON.stringify((await as(world.ada, 'task.read', { recordId: shared })).body);
    for (const secret of [TITLE, DESCRIPTION, TEAM_NOTE, CLIENT_NOTE]) {
      expect(control).toContain(secret);
    }
  });

  it('item 2: the task fields come from the catalogue, so classifying one shows exactly it', async () => {
    // Catalogue data, not the share: no owning operation reclassifies a spine
    // field yet, so the classification is set directly and put back after.
    const classify = async (key: string, visibility: 'shared' | 'internal') =>
      await world.db.app.withBusiness(world.alpha, (tx) =>
        tx.query(
          `update field_defs set visibility_class = $1
            where record_type_id = $2 and key = $3`,
          [visibility, world.spineAlpha.taskTypeId, key],
        ),
      );
    const fieldsRead = async () =>
      (
        (await as(ext, 'task.read', { recordId: shared })).body['sharedTask'] as {
          readonly fields: Readonly<Record<string, unknown>>;
        }
      ).fields;
    await classify('description', 'shared');
    try {
      expect(Object.keys(await fieldsRead()).toSorted()).toStrictEqual([
        'description',
        'state',
        'title',
      ]);
    } finally {
      await classify('description', 'internal');
    }
    await classify('title', 'internal');
    try {
      const fields = await fieldsRead();
      expect(Object.keys(fields)).toStrictEqual(['state']);
      expect(JSON.stringify(fields)).not.toContain(TITLE);
    } finally {
      await classify('title', 'shared');
    }
  });

  it('item 3: a sibling record and the board are NOT_FOUND, the queue is refused', async () => {
    const siblingRead = await as(ext, 'task.read', { recordId: sibling });
    const invented = await as(ext, 'task.read', { recordId: randomUUID() });
    const board = await as(ext, 'task.board', { board: null });
    const queue = await as(ext, 'task.queue', {});
    console.log(
      `R4 denials: sibling ${siblingRead.status} ${siblingRead.code}; invented ${invented.status} ` +
        `${invented.code}; board ${board.status} ${board.code}; queue ${queue.status} ${queue.code}`,
    );
    expect(siblingRead.code).toBe('NOT_FOUND');
    expect(board.code).toBe('NOT_FOUND');
    expect(queue.code).toBe('SCOPE_NOT_GRANTED');
    // A real sibling and an invented identifier answer the same thing.
    expect({ status: siblingRead.status, body: siblingRead.body }).toStrictEqual({
      status: invented.status,
      body: invented.body,
    });
    for (const answer of [siblingRead, board, queue]) {
      expect(JSON.stringify(answer.body)).not.toContain(SIBLING_TITLE);
      expect(JSON.stringify(answer.body)).not.toContain(TITLE);
    }
  });

  // Timeout only (TEST-TIMEOUTS): every write in the surface is sent one at a
  // time over HTTP, which takes about 5 s alone and ran past the 5 s default
  // while the machine was busy. The assertions are unchanged.
  it('item 3: every write is refused on authority, nothing moves, and every attempt is audited', async () => {
    const REVOCATION_BODIES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
      'grant.revoke': { grantId: randomUUID() },
      'delegation.revoke': { delegationId: randomUUID() },
    };
    // The matrix's own valid bodies, so a refusal is authority's and not the
    // body check's. Each is sent as it is (against a sibling the admin made, or
    // the business) and again aimed at the shared record itself.
    const positiveBody = createPositiveBody({
      alphaTaskId: shared,
      assigneePersonId: world.ada.personId as string,
      asPerson: async (name, body) =>
        await as(world.ada, name, { operationId: randomUUID(), ...body }),
      freshTask: async (title) => {
        const made = await as(world.ada, 'task.create', {
          operationId: randomUUID(),
          fields: { title },
        });
        return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
      },
    });
    const revision = await revisionOf(shared);
    const writes = COMMAND_SURFACE.filter((declaration) => declaration.kind !== 'read');
    const answers: [string, Answer][] = [];
    for (const declaration of writes) {
      // eslint-disable-next-line no-await-in-loop -- one attempt at a time, in the audit's order
      const prepared = await positiveBody(declaration);
      // The two revocations have no body in the matrix (it records their
      // positive control elsewhere), so each is sent naming a row of its own
      // kind: a `recordId` they do not take is refused as a stray identifier
      // before authority is asked (architecture observation 2).
      const body =
        'body' in prepared
          ? prepared.body
          : (REVOCATION_BODIES[declaration.name] ?? {
              recordId: shared,
              expectedRevision: revision,
              fields: { title: 'from outside' },
            });
      const aimed =
        'recordId' in body && body['recordId'] !== shared
          ? [body, { ...body, recordId: shared, expectedRevision: revision }]
          : [body];
      for (const one of aimed) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await as(ext, declaration.name, { operationId: randomUUID(), ...one });
        answers.push([`${declaration.name}${one['recordId'] === shared ? '@shared' : ''}`, answer]);
      }
    }
    console.log(
      `R4 writes: ${answers.map(([name, answer]) => `${name} ${answer.status} ${answer.code}`).join('; ')}`,
    );
    for (const [name, answer] of answers) {
      expect(answer.code, name).not.toBe('ok');
      expect(answer.status, name).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(answer.body), name).not.toContain(TITLE);
      // Pickup and handback are refused on the person path by design
      // (`handlers.ts`), before authority; every other write reaches it.
      if (!/^task\.(pickup|handback)/u.test(name)) {
        expect(answer.code, name).toBe('SCOPE_NOT_GRANTED');
      }
    }
    expect(await revisionOf(shared)).toBe(revision);

    const audited = await world.db.app.withBusiness(world.alpha, (tx) =>
      tx.query<{ readonly command: string; readonly outcome: string }>(
        `select command, outcome from audit_events where actor_id = $1`,
        [ext.actorId],
      ),
    );
    const refusedWrites = audited.filter(
      (row) => row.outcome === 'refused' && writes.some((one) => one.name === row.command),
    );
    expect(refusedWrites).toHaveLength(answers.length);
    const appliedWrites = audited.filter(
      (row) => row.outcome !== 'refused' && writes.some((one) => one.name === row.command),
    );
    expect(appliedWrites).toStrictEqual([]);
    const refusedReads = audited.filter((row) => row.outcome === 'refused').map((r) => r.command);
    expect(refusedReads).toEqual(expect.arrayContaining(['task.read', 'task.board', 'task.queue']));
  }, 30_000);
});
