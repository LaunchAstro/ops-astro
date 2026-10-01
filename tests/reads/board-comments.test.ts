// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-8's comment badge on the board (`MP-5-8 comment badge count and door`,
// the server leg) and MP-5-12's owed count (`MP-5-12 count across surfaces`,
// the board leg). Each task.board row carries `comments`: for the reader only,
// how many of the reader's own open inbox items of reason `client_comment` and
// of reason `mention` are about that task, and when the newest of them was
// raised. The answer carries `owed`, INB-1's one permission-checked count, the
// number `inbox.count` gives the same caller. Three real crossings, statuses
// checked: another person on a task both read, another client in the same
// business, another business. A canary item's date never reaches another
// reader's body.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  raiseInboxItem,
  type BusinessId,
  type InboxReason,
} from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { aiWorld, created, onClient, type AiWorld } from '../commands/ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('board-comments: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('comments');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

interface Comments {
  readonly client: number;
  readonly mentions: number;
  readonly latest: string | null;
}
interface Row {
  readonly id: string;
  readonly comments?: Comments;
}
interface Board {
  readonly code: string;
  readonly text: string;
  readonly rows: readonly Row[];
  readonly owed?: number;
}

const NONE: Comments = { client: 0, mentions: 0, latest: null };

const board = async (business: BusinessId, by: Member): Promise<Board> => {
  const answer = await executeRead(w.world.db.app, business, by.presented, {
    read: 'task.board',
    board: null,
  });
  const text = JSON.stringify(answer);
  if (isCommandRefusal(answer)) return { code: answer.code, text, rows: [] };
  const body = answer as unknown as { readonly tasks: readonly Row[]; readonly owed?: number };
  return {
    code: 'ok',
    text,
    rows: body.tasks,
    ...(body.owed === undefined ? {} : { owed: body.owed }),
  };
};

const commentsOf = (b: Board, id: string): Comments | undefined =>
  b.rows.find((row) => row.id === id)?.comments;

/** One open item for `recipient` about `task`, raised at `at` when given. */
const raise = async (
  recipient: Member,
  task: string,
  reason: InboxReason,
  at?: string,
  business: BusinessId = w.world.business,
): Promise<string> => {
  const id = await w.world.db.app.withBusiness(
    business,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: recipient.personId,
        subjectRecordId: task,
        reason,
        fact: { kind: 'record', id: randomUUID() },
      }),
  );
  if (at !== undefined) {
    await w.world.db.admin.execute(`update public.inbox_items set raised_at = $2 where id = $1`, [
      id,
      at,
    ]);
  }
  return id;
};

/** A canary date no other item carries, one day each: it never reaches another reader. */
let canaries = 0;
const canaryAt = (): string => {
  canaries += 1;
  return `2031-0${String(canaries)}-1${String(canaries)}T04:05:06.789Z`;
};

describe.skipIf(serverUrl === undefined)('MP-5-8 comment badge count and door', () => {
  it('a row counts the reader’s open client signals and mentions on it, with the newest date', async () => {
    const task = await created(w, w.p, 'waiting on us');
    const quiet = await created(w, w.p, 'nothing waiting');
    await raise(w.p, task, 'client_comment', '2026-09-18T01:00:00.000Z');
    await raise(w.p, task, 'client_comment', '2026-09-20T01:00:00.000Z');
    await raise(w.p, task, 'mention', '2026-09-19T01:00:00.000Z');
    // Neither an assignment nor a cleared mention is a comment waiting.
    await raise(w.p, task, 'assignment', '2026-09-29T01:00:00.000Z');
    const cleared = await raise(w.p, task, 'mention', '2026-09-30T01:00:00.000Z');
    await w.world.db.admin.execute(
      `update public.inbox_items
          set work_state = 'cleared', closed_at = now(), closed_by_person_id = recipient_person_id
        where id = $1`,
      [cleared],
    );

    const mine = await board(w.world.business, w.p);
    expect(mine.code).toBe('ok');
    expect(commentsOf(mine, task)).toStrictEqual({
      client: 2,
      mentions: 1,
      latest: '2026-09-20T01:00:00.000Z',
    });
    expect(commentsOf(mine, quiet)).toStrictEqual(NONE);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-12 count across surfaces', () => {
  it('the board’s owed count is the one inbox.count gives the same caller', async () => {
    const task = await created(w, w.p, 'owed here');
    await raise(w.p, task, 'decision');
    const counted = await executeRead(w.world.db.app, w.world.business, w.p.presented, {
      read: 'inbox.count',
    });
    const owed = (counted as unknown as { readonly owed: number }).owed;
    expect(owed).toBeGreaterThan(0);
    expect((await board(w.world.business, w.p)).owed).toBe(owed);
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 comment counts: person to person', () => {
  it('P’s board never counts Q’s items, even on a task both read', async () => {
    const shared = await created(w, w.p, 'both read this');
    const at = canaryAt();
    await raise(w.q, shared, 'mention', at);
    await raise(w.q, shared, 'client_comment', at);

    const ps = await board(w.world.business, w.p);
    expect(ps.code).toBe('ok');
    expect(commentsOf(ps, shared)).toStrictEqual(NONE);
    expect(ps.text).not.toContain(at.slice(0, 10));
    const qs = await board(w.world.business, w.q);
    expect(commentsOf(qs, shared)).toStrictEqual({ client: 1, mentions: 1, latest: at });
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 comment counts: client to client', () => {
  it('a reader held to client X is counted X’s items only; Y’s task and items are not served', async () => {
    const x = await created(w, w.p, 'Client X work');
    const y = await created(w, w.p, 'Client Y work');
    await onClient(w, x, randomUUID());
    await onClient(w, y, randomUUID());
    const reader = await enrol(w.world.db.app, w.world.business, `x-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id: x });
    });
    const onX = '2026-09-21T02:00:00.000Z';
    await raise(reader, x, 'client_comment', onX);
    const at = canaryAt();
    // The reader's own items on Y, whose task they cannot read.
    const onY = await raise(reader, y, 'mention', at);
    await raise(reader, y, 'client_comment', at);

    const theirs = await board(w.world.business, reader);
    expect(theirs.code).toBe('ok');
    expect(theirs.rows.map((row) => row.id)).toStrictEqual([x]);
    expect(commentsOf(theirs, x)).toStrictEqual({ client: 1, mentions: 0, latest: onX });
    expect(theirs.owed).toBe(1);
    expect(theirs.text).not.toContain(y);
    expect(theirs.text).not.toContain(onY);
    expect(theirs.text).not.toContain(at.slice(0, 10));
  });
});

describe.skipIf(serverUrl === undefined)('MP-5-8 comment counts: business to business', () => {
  it('each business’s board counts its own items and none of the other’s', async () => {
    const home = await created(w, w.p, 'Home work');
    const homeAt = canaryAt();
    await raise(w.p, home, 'mention', homeAt);
    const bravo = await insertBusiness(w.world.db.app, `cmt-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // eslint-disable-next-line no-await-in-loop -- two grants
        await grantTo(tx, there, action);
      }
    });
    const made = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'Bravo task' },
    } as never);
    if (isCommandRefusal(made)) throw new Error(`bravo create refused ${made.code}`);
    const bravoTask = made.recordId ?? '';
    const bravoAt = canaryAt();
    await raise(there, bravoTask, 'client_comment', bravoAt, bravo);

    const theirs = await board(bravo, there);
    expect(theirs.code).toBe('ok');
    expect(commentsOf(theirs, bravoTask)).toStrictEqual({
      client: 1,
      mentions: 0,
      latest: bravoAt,
    });
    expect(theirs.text).not.toContain(home);
    expect(theirs.text).not.toContain(homeAt.slice(0, 10));
    const ours = await board(w.world.business, w.p);
    expect(ours.text).not.toContain(bravoTask);
    expect(ours.text).not.toContain(bravoAt.slice(0, 10));
    expect(commentsOf(ours, home)?.latest).toBe(homeAt);
  });
});
