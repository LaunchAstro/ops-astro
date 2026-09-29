// SPDX-License-Identifier: AGPL-3.0-only
//
// One world for AW-03's cases: a business whose owner holds `conversation:write`
// (the key's install holder, CAPABILITY-SLICES), a colleague who holds it too
// and no read-any grant, and the real API composed over a fresh database. The
// conversation's system operations (the wrap-up at quiet and the purge) are
// the runtime's own functions, called here as the worker calls them; the only
// thing a case does by hand is age a conversation's last activity, which is
// the clock, not the operation.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { createCli, type CliAnswer } from '../../apps/cli/client.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { personPath, type Controls } from './controls-fixture.ts';

export const CONVERSATION = 'conversation';

/** The code revision a case's wrap-up names as its writer's. */
export const CODE_REVISION = 'aw03test';

export interface ConversationWorld {
  readonly fixture: ApiFixture;
  readonly api: Hono;
  readonly owner: Member;
  readonly colleague: Member;
  /** A person's call through the mounted API, with a fresh operation id on a write. */
  readonly as: (member: Member, name: string, body: Record<string, unknown>) => Promise<Answer>;
  /** The shipped command line over the in-process app, as `member`. */
  readonly cli: (member: Member, name: string, body: Record<string, unknown>) => Promise<CliAnswer>;
  /**
   * Move a conversation's creation and last activity back by `days`: the clock,
   * never the operation. Messages keep their times; the database refuses any
   * edit of one, which is the point.
   */
  readonly age: (conversationId: string, days: number) => Promise<void>;
  readonly count: (sql: string, parameters: readonly unknown[]) => Promise<number>;
  readonly drop: () => Promise<void>;
}

const WRITES = new Set(['conversation.start', 'conversation.message', 'task.create']);

const bodyOf = (name: string, body: Record<string, unknown>): Record<string, unknown> =>
  WRITES.has(name) ? { operationId: randomUUID(), ...body } : body;

/** A person's call through the mounted API, with a fresh operation id on a write. */
const asOn =
  (api: Hono): ConversationWorld['as'] =>
  async (member, name, body) =>
    await post(
      api,
      personPath(name),
      bodyOf(name, body),
      authorised(await tokenFor(member.presented.subject)),
    );

/** The shipped command line over the in-process app. */
const cliOn =
  (api: Hono): ConversationWorld['cli'] =>
  async (member, name, body) =>
    await createCli({
      businessKey: BUSINESS_KEY,
      credential: await tokenFor(member.presented.subject),
      transport: async (path, sent, credential) =>
        await api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authorised(credential) },
            body: sent,
          }),
        ),
    }).run(name, bodyOf(name, body));

/** A world of its own, or one on a controls world (its member is the owner) for agent crossings. */
export async function conversationWorld(on: string | Controls): Promise<ConversationWorld> {
  const fixture = typeof on === 'string' ? await createApiFixture(on) : on.fixture;
  const api = typeof on === 'string' ? fixture.compose() : on.api;
  const owner = fixture.member;
  const colleague = await enrol(fixture.db.app, fixture.business, 'colleague');
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    // The window and the work window the purge reads, at their shipped values.
    await installBusinessSettings(tx);
    await grantTo(tx, owner, 'write', undefined, false, CONVERSATION);
    await grantTo(tx, colleague, 'write', undefined, false, CONVERSATION);
    await grantTo(tx, colleague, 'read');
  });
  return {
    fixture,
    api,
    owner,
    colleague,
    as: asOn(api),
    cli: cliOn(api),
    age: async (conversationId, days) => {
      await fixture.db.admin.execute(
        `update public.conversations
            set last_activity_at = last_activity_at - make_interval(days => $2::int),
                created_at = created_at - make_interval(days => $2::int)
          where id = $1`,
        [conversationId, days],
      );
    },
    count: async (sql, parameters) => {
      const rows = await fixture.db.admin.execute<{ readonly n: string }>(sql, [...parameters]);
      return Number(rows[0]?.n ?? 0);
    },
    drop: async () => await fixture.drop(),
  };
}

/** The applied write's detail, or a failure that says what came back. */
export function detail(answer: Answer | CliAnswer): Record<string, unknown> {
  const body = answer.body as Record<string, unknown> | undefined;
  const found = body?.['detail'];
  if (answer.status !== 200 || typeof found !== 'object' || found === null) {
    throw new Error(`not an applied write: ${String(answer.status)} ${JSON.stringify(body)}`);
  }
  return found as Record<string, unknown>;
}

/** Start a conversation as `member` and hand back its id. */
export async function started(
  world: ConversationWorld,
  member: Member,
  body: Record<string, unknown>,
): Promise<string> {
  const id = detail(await world.as(member, 'conversation.start', body))['conversationId'];
  if (typeof id !== 'string') throw new Error('conversation.start answered no conversationId');
  return id;
}
