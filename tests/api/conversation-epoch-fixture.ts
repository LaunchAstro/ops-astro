// SPDX-License-Identifier: AGPL-3.0-only
//
// What the context-epoch race, crash and retry proofs share. A purge of the
// task a conversation was opened on bumps `conversations.context_epoch` under
// the conversation's row lock; each question and reply records the epoch it
// was written under, read from the row it holds. These proofs run each of
// those writes on a connection of its own (the fixture's app pool is `max: 1`,
// which would run two transactions one after the other), stopped right at a
// named statement: held there while the other side runs, or failed there as a
// crash would fail it. Every step is ordered by what the database reports,
// never by a sleep.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { readReplayAnswer } from '../../packages/core-connectors/src/replay.ts';
import {
  connect,
  writeBusinessSetting,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { grantTo } from '../commands/fixture.ts';
import { latch } from '../support/lock-wait-race.ts';
import { testSignIn } from '../support/sign-in.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  authorised,
  createApiFixture,
  ISSUER,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';

/** Where a stepped transaction stops: held before or after the statement, or failed after it. */
export type StepHow = 'hold-before' | 'hold-after' | 'fail-after';

export interface Stepped {
  /** A database on a connection of its own that stops once, at the first statement naming the marker. */
  readonly database: Database;
  /** Opens with the stopped transaction's backend once it has stopped there. */
  readonly reached: Promise<number>;
  /** Lets a held transaction go on. */
  readonly release: () => void;
  /**
   * Ends the held transaction's backend, as a serving process dying with its
   * connection ends it, and waits until the server reports it gone. The held
   * caller is never let go on: the process it stands for is dead.
   */
  readonly crash: (fixture: ApiFixture) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A connection whose first transaction to send a statement containing `marker` stops there. */
export function stepped(url: string, marker: string, how: StepHow): Stepped {
  const database = connect(url);
  const reached = latch<number>();
  const released = latch<void>();
  let armed = true;
  let dead = false;
  const stop = async (tx: TenantQuery): Promise<void> => {
    armed = false;
    const [me] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    reached.open(Number(me?.pid));
    if (how === 'fail-after') throw new Error(`the transaction failed at "${marker}"`);
    await released.promise;
  };
  return {
    database: {
      log: database.log,
      close: async () => await database.close(),
      withBusiness: async (businessId, run) =>
        await database.withBusiness(
          businessId,
          async (tx) =>
            await run({
              ...tx,
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                const here = armed && sql.includes(marker);
                if (here && how === 'hold-before') await stop(tx);
                const rows = await tx.query<Row>(sql, values);
                if (here && how !== 'hold-before') await stop(tx);
                return rows;
              },
            }),
        ),
    },
    reached: reached.promise,
    release: () => released.open(),
    crash: async (fixture) => {
      dead = true;
      const pid = await reached.promise;
      await fixture.db.admin.execute('select pg_terminate_backend($1)', [pid]);
      await untilGone(fixture, pid);
    },
    close: async () => {
      if (dead) return;
      released.open();
      await database.close();
    },
  };
}

/** Each reply's words are new, so a reply is found by its own text in what a model is sent. */
const numberedAnswers = (body: unknown) => {
  const answer = readReplayAnswer(body);
  return answer === undefined ? undefined : { ...answer, text: `answer-${randomUUID()}` };
};

export interface EpochWorld {
  readonly model: LocalModel;
  readonly fixture: ApiFixture;
  readonly w: ConversationWorld;
  /** The API with no exchange mounted: a question is kept and nothing answers it. */
  readonly unanswered: Hono;
  readonly drop: () => Promise<void>;
}

/** A conversation world whose owner may trash and purge, with trash purged at once. */
export async function epochWorld(part: string): Promise<EpochWorld> {
  const model = await localModel(numberedAnswers);
  const fixture = await createApiFixture(part);
  const w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, w.owner, 'manage');
    await grantTo(tx, w.owner, 'share');
    const written = await writeBusinessSetting(tx, {
      key: 'retention_window_days',
      owningOperation: 'settings.set_retention_window',
      value: 0,
    });
    expect(written).not.toBeUndefined();
  });
  return {
    model,
    fixture,
    w,
    unanswered: fixture.compose(),
    drop: async () => {
      await w.drop();
      await model.close();
    },
  };
}

/** The server's composition root over `database`, with `exchange` mounted if given. */
export function composedOn(
  fixture: ApiFixture,
  database: Database,
  exchange?: ConversationExchange,
): Hono {
  if (exchange === undefined) return fixture.compose(undefined, undefined, database);
  return composeApi({
    keys: runtimeKeys({ ...fixture.environment }),
    database,
    admin: fixture.db.admin,
    signIn: testSignIn(ISSUER),
    executeRead,
    answerConversation: exchange,
  }).app;
}

/** The owner's call through `api`. */
export async function ownerOn(
  c: EpochWorld,
  api: Hono,
  name: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Answer> {
  const token = await tokenFor(c.w.owner.presented.subject);
  return await post(api, personPath(name), body, authorised(token));
}

export interface Opened {
  readonly taskId: string;
  readonly revision: unknown;
  readonly conversationId: string;
  /** The first question, answered while the task was live. */
  readonly canary: string;
}

/** A task, and a conversation opened on it whose first question was answered. */
export async function openedOnTask(c: EpochWorld): Promise<Opened> {
  const made = await c.w.as(c.w.owner, 'task.create', { fields: { title: 'task to be purged' } });
  expect(made.status).toBe(200);
  const taskId = String(made.body['recordId']);
  const canary = `before-purge-${randomUUID()}`;
  const opened = await c.w.as(c.w.owner, 'conversation.start', {
    body: canary,
    scope: { kind: 'task', id: taskId },
  });
  expect(opened.body['reply']).toMatchObject({ answered: true });
  return {
    taskId,
    revision: made.body['revision'],
    conversationId: String(detail(opened)['conversationId']),
    canary,
  };
}

/** The task trashed, and its trash aged past the window, so the next purge takes it. */
export async function trashed(c: EpochWorld, o: Opened): Promise<void> {
  const gone = await c.w.as(c.w.owner, 'task.trash', {
    operationId: randomUUID(),
    recordId: o.taskId,
    expectedRevision: o.revision,
  });
  expect(gone.status).toBe(200);
  await c.fixture.db.admin.execute(
    "update public.records set deleted_at = now() - interval '1 hour' where business_id = $1 and id = $2",
    [c.fixture.business, o.taskId],
  );
}

/** A purge through `api`, with `operationId`. */
export async function purgeOn(
  c: EpochWorld,
  api: Hono,
  operationId: string = randomUUID(),
): Promise<Answer> {
  return await ownerOn(c, api, 'task.purge', { operationId });
}

export interface Epochs {
  readonly epoch: number;
  readonly detached: boolean;
  /** Each message as kept, oldest first. */
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly body: string;
    readonly epoch: number;
    readonly answers: string | null;
  }[];
}

/** The conversation's epoch and scope, and the epoch each of its messages was kept under. */
export async function epochsOf(fixture: ApiFixture, conversationId: string): Promise<Epochs> {
  const admin = fixture.db.admin;
  const [row] = await admin.execute<{ readonly epoch: number; readonly detached: boolean }>(
    `select context_epoch as epoch, scope_record_id is null as detached
       from public.conversations where id = $1`,
    [conversationId],
  );
  const messages = await admin.execute<Epochs['messages'][number]>(
    `select id::text, role, body, context_epoch as epoch, answers_message_id::text as answers
       from public.conversation_messages where conversation_id = $1
      order by created_at, id`,
    [conversationId],
  );
  if (row === undefined) throw new Error(`no conversation ${conversationId}`);
  return { epoch: row.epoch, detached: row.detached, messages };
}

/** Why the message was marked refused for its page, if it was. */
export async function marksOf(fixture: ApiFixture, messageId: string): Promise<readonly string[]> {
  const rows = await fixture.db.admin.execute<{ readonly code: string }>(
    `select refusal_code as code from public.audit_events
      where command = 'model.call_refused' and attempted ->> 'messageId' = $1`,
    [messageId],
  );
  return rows.map((row) => row.code);
}

/** A new question in the conversation, answered: what the model was sent for it. */
export async function sentForNext(c: EpochWorld, conversationId: string): Promise<string> {
  const seen = c.model.provider.seen.length;
  const next = await c.w.as(c.w.owner, 'conversation.message', {
    conversationId,
    body: `next-${randomUUID()}`,
  });
  expect(next.body['reply']).toMatchObject({ answered: true });
  expect(c.model.provider.seen).toHaveLength(seen + 1);
  return c.model.provider.seen.at(-1)?.body ?? '';
}

/** Waits until the server reports the backend `pid` gone. */
async function untilGone(fixture: ApiFixture, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await fixture.db.admin.execute('select 1 from pg_stat_activity where pid = $1', [
      pid,
    ]);
    if (rows.length === 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`backend ${String(pid)} was never gone`);
}
