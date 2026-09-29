// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-1: the board a task sits on, as its page's crumb reads it, against a
// real database.
//
// A board is a task (the `board` slot names one), so its title is a task
// title: `task.read` names it only to a reader who may read that board, by the
// same single-record check `task.read` itself makes. Each crossing below plants
// a canary title on a board the reader may not read and reads every body for
// it: a canary in a body is the leak, and so is a board said to be readable
// that the reader could not open.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { agentWorld, detailOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-board-crumb: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

const CANARY = `canary-${randomUUID()}`;

describe.skipIf(serverUrl === undefined)('MP-4-1 the board on the task read', () => {
  let db: FreshDatabase;
  let alpha: BusinessId;
  let bravo: BusinessId;
  let owner: Member;
  let bravoOwner: Member;
  let clientAViewer: Member;
  let boardReader: Member;
  const ids: Record<string, string> = {};

  const command = async (business: BusinessId, member: Member, body: Body) => {
    const answer = await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
    if (isCommandRefusal(answer))
      throw new Error(`${String(body['command'])} refused ${answer.code}`);
    return answer;
  };

  const revisionOf = async (recordId: string) =>
    Number(
      (
        await db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where id = $1`,
          [recordId],
        )
      )[0]?.revision,
    );

  const make = async (
    business: BusinessId,
    by: Member,
    name: string,
    title: string,
    placed: { readonly board?: string; readonly client?: string } = {},
  ) => {
    const made = await command(business, by, {
      command: 'task.create',
      fields: { title },
      ...(placed.board === undefined ? {} : { board: placed.board }),
    });
    const recordId = made.recordId ?? '';
    if (placed.client !== undefined) {
      await command(business, by, {
        command: 'task.set_party',
        recordId,
        expectedRevision: await revisionOf(recordId),
        fields: { client: placed.client },
      });
    }
    ids[name] = recordId;
    return recordId;
  };

  const read = async (business: BusinessId, member: Member, recordId: string) =>
    await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

  const boardOf = async (business: BusinessId, member: Member, recordId: string) => {
    const answer = await read(business, member, recordId);
    if (isCommandRefusal(answer) || !('task' in answer)) {
      throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
    }
    return { board: answer.task.board, body: JSON.stringify(answer) };
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'bc' });
    alpha = (await insertBusiness(db.app, 'crumb-alpha')) as BusinessId;
    bravo = (await insertBusiness(db.app, 'crumb-bravo')) as BusinessId;
    await installSpine(db.app, alpha);
    await installSpine(db.app, bravo);
    owner = await enrol(db.app, alpha, 'owner');
    bravoOwner = await enrol(db.app, bravo, 'bravo-owner');
    clientAViewer = await enrol(db.app, alpha, 'client-a-viewer');
    boardReader = await enrol(db.app, alpha, 'board-reader');
    await db.app.withBusiness(alpha, async (tx) => {
      // `share` only so a task can be put under its client (`task.set_party`).
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, owner, action);
      }
    });
    await db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, bravoOwner, action);
      }
    });
    const clientA = randomUUID();
    const clientB = randomUUID();
    const website = await make(alpha, owner, 'website', 'Website Projects', { client: clientA });
    const secret = await make(alpha, owner, 'secret', CANARY, { client: clientB });
    await make(alpha, owner, 'onWebsite', 'Budget pacing fix', { board: website, client: clientA });
    await make(alpha, owner, 'onSecret', 'client A work on B', { board: secret, client: clientA });
    await make(alpha, owner, 'unboarded', 'no board yet');
    // Bravo: a board with the canary title, which an Alpha task is then made to
    // point at behind every command's back, so only the read's own filter
    // stands between it and an Alpha body.
    const foreign = await make(bravo, bravoOwner, 'bravoBoard', CANARY);
    const planted = await make(alpha, owner, 'planted', 'points across');
    await db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{board}', to_jsonb($2::text)), uuid_5 = $2::uuid
        where id = $1`,
      [planted, foreign],
    );
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAViewer, 'read', { kind: 'record', id: ids['onSecret'] ?? '' });
      await grantTo(tx, boardReader, 'read', { kind: 'record', id: ids['onWebsite'] ?? '' });
      await grantTo(tx, boardReader, 'read', { kind: 'record', id: website });
    });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('MP-4-1 crumb', () => {
    it('names the board the task sits on, from the board’s own record', async () => {
      const { board } = await boardOf(alpha, owner, ids['onWebsite'] ?? '');
      expect(board).toStrictEqual({ readable: true, title: 'Website Projects' });
    });

    it('a task on no board says so with null, not an empty title', async () => {
      expect((await boardOf(alpha, owner, ids['unboarded'] ?? '')).board).toBeNull();
    });

    it('a record-scoped reader who may read the board is told its title too', async () => {
      const { board } = await boardOf(alpha, boardReader, ids['onWebsite'] ?? '');
      expect(board).toStrictEqual({ readable: true, title: 'Website Projects' });
    });

    it('a board renamed is the next read’s title: nothing is copied onto the task', async () => {
      const website = ids['website'] ?? '';
      await command(alpha, owner, {
        command: 'task.update',
        recordId: website,
        expectedRevision: await revisionOf(website),
        fields: { title: 'Websites' },
      });
      const { board } = await boardOf(alpha, owner, ids['onWebsite'] ?? '');
      expect(board).toStrictEqual({ readable: true, title: 'Websites' });
      await command(alpha, owner, {
        command: 'task.update',
        recordId: website,
        expectedRevision: await revisionOf(website),
        fields: { title: 'Website Projects' },
      });
    });
  });

  describe('MP-4-1 isolation', () => {
    it('another business: a board slot pointing across reads as no board, and no canary', async () => {
      const { board, body } = await boardOf(alpha, owner, ids['planted'] ?? '');
      expect(board).toBeNull();
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(ids['bravoBoard']);
      const foreign = await read(alpha, owner, ids['bravoBoard'] ?? '');
      expect(isCommandRefusal(foreign) ? foreign.code : 'answered').toBe('NOT_FOUND');
    });

    it('another client in the same business: the board is withheld, its title never sent', async () => {
      const { board, body } = await boardOf(alpha, clientAViewer, ids['onSecret'] ?? '');
      expect(board).toStrictEqual({ readable: false });
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(ids['secret']);
      // The board itself is refused to this reader, so the crumb said no more
      // than the refusal does.
      const direct = await read(alpha, clientAViewer, ids['secret'] ?? '');
      expect(isCommandRefusal(direct) ? direct.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(direct)).not.toContain(CANARY);
    });

    it('a reader holding one board is told that one only, per board and not per reader', async () => {
      const { board } = await boardOf(alpha, boardReader, ids['onWebsite'] ?? '');
      expect(board).toStrictEqual({ readable: true, title: 'Website Projects' });
      const refused = await read(alpha, boardReader, ids['onSecret'] ?? '');
      expect(isCommandRefusal(refused) ? refused.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused)).not.toContain(CANARY);
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-1 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('bca', `crumb-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('is told its task sits on a board and never the board’s title', async () => {
      const decider = await world.decider('decider');
      const revision = async (recordId: string) =>
        Number(
          (
            await world.db.admin.execute<{ readonly revision: string }>(
              `select revision::text as revision from public.records where id = $1`,
              [recordId],
            )
          )[0]?.revision,
        );
      const made = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      });
      const boardId = isCommandRefusal(made) ? '' : (made.recordId ?? '');
      const picked = await world.pickUp(decider, 'the agent’s task');
      const moved = await world.asPerson(decider, {
        command: 'task.move',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await revision(picked.taskId),
        board: boardId,
      });
      expect(isCommandRefusal(moved) ? moved.code : 'moved').toBe('moved');
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { board: unknown };
      expect(task.board).toStrictEqual({ readable: false });
      expect(JSON.stringify(own)).not.toContain(CANARY);
      expect(JSON.stringify(own)).not.toContain(boardId);
      const board = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: boardId },
        picked.credential,
      );
      expect(isCommandRefusal(board) ? board.code : 'answered').not.toBe('answered');
      expect(JSON.stringify(board)).not.toContain(CANARY);
    });
  },
);
