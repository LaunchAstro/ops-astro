// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's task origin on the audit chain (0199, ORCH25-SL12-ORIGIN2): which
// conversation created a task is a fact of its creation audit event, in a
// nullable `origin_conversation_id` the chain's one hash formula reads.
//
// Three things are proved on real databases. A chain written before 0199
// verifies unchanged after it, every stored hash the same, because a null
// origin adds nothing to the hashed text. An origin, when present, is in the
// hash, so the event cannot be read with it and hash without it. And an
// origin names a conversation of the event's own business: another
// business's conversation or a made-up id is refused and writes nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  readAuditEvents,
  verifyAuditChain,
  writeAuditEvent,
} from '../../packages/core-commands/src/commands/audit.ts';
import { payloadDigest } from '../../packages/core-digest/src/digest.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('audit origin: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const THROUGH_0049 = (version: string): boolean => version.slice(0, 4) <= '0198';

interface Member {
  readonly business: string;
  readonly person: string;
  readonly actor: string;
}

async function member(database: Database, key: string): Promise<Member> {
  const business = await insertBusiness(database, key);
  return await database.withBusiness(business, async (tx) => {
    const person = await insertPerson(tx, 'auditor');
    return { business, person, actor: await insertActor(tx, person) };
  });
}

/** A conversation owned by `who`, as `conversation.start` leaves one (the row, not the body). */
async function conversationOf(database: Database, who: Member): Promise<string> {
  const id = randomUUID();
  await database.withBusiness(who.business, async (tx) => {
    await tx.query(
      `insert into conversations (business_id, id, owner_actor_id, owner_person_id, title)
       values ($1, $2, $3, $4, 'origin')`,
      [tx.businessId, id, who.actor, who.person],
    );
  });
  return id;
}

const write = async (
  database: Database,
  who: Member,
  event: Partial<Parameters<typeof writeAuditEvent>[1]> = {},
): Promise<{ readonly seq: string; readonly hash: string }> =>
  await database.withBusiness(
    who.business,
    async (tx) =>
      await writeAuditEvent(tx, {
        actorId: who.actor,
        command: 'task.create',
        operationId: randomUUID(),
        outcome: 'applied',
        payloadDigest: payloadDigest({ title: 'one' }),
        ...event,
      }),
  );

/**
 * An event as the writer wrote one before 0199: the same insert, without the
 * column 0199 adds. The trigger writes the position, the link and the hash.
 */
async function writeAsBefore(
  database: Database,
  who: Member,
  event: {
    readonly command: string;
    readonly operationId: string | null;
    readonly outcome?: string;
    readonly refusalCode?: string;
    readonly attempted?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await database.withBusiness(who.business, async (tx) => {
    await tx.query(
      `insert into audit_events
         (business_id, id, actor_id, command, operation_id, outcome, refusal_code,
          subject_record_id, payload_digest, attempted, seq, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, null, $8, $9::text::jsonb, 1, null, repeat('0', 64))`,
      [
        tx.businessId,
        randomUUID(),
        who.actor,
        event.command,
        event.operationId,
        event.outcome ?? 'applied',
        event.refusalCode ?? null,
        payloadDigest({ title: 'one' }),
        event.attempted === undefined ? null : JSON.stringify(event.attempted),
      ],
    );
  });
}

// eslint-disable-next-line max-lines-per-function -- one upgraded database, one journey
describe.skipIf(serverUrl === undefined)('audit origin: a chain written before 0199', () => {
  let db: EmptyDatabase;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'auditorigin0033' });
    const onDisk = readMigrations('migrations');
    await applyMigrations(
      db.admin,
      onDisk.filter((m) => THROUGH_0049(m.version)),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('audit origin: verifies unchanged after 0199, every stored hash the same, and the chain carries on', async () => {
    const who = await member(db.app, 'origin-before');
    await writeAsBefore(db.app, who, { command: 'task.create', operationId: randomUUID() });
    await writeAsBefore(db.app, who, {
      command: 'task.create',
      operationId: randomUUID(),
      outcome: 'refused',
      refusalCode: 'FIELD_VALUE_INVALID',
      attempted: { seq: '9' },
    });
    await writeAsBefore(db.app, who, { command: 'conversation.purge', operationId: null });
    const before = await db.app.withBusiness(who.business, readAuditEvents);
    expect(before).toHaveLength(3);

    await db.closeSessions();
    await migrate(db.admin, 'migrations');

    const columns = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from information_schema.columns
        where table_schema = 'public' and table_name = 'audit_events'
          and column_name = 'origin_conversation_id' and is_nullable = 'YES'`,
    );
    expect(columns[0]?.n).toBe('1');
    const after = await db.app.withBusiness(who.business, readAuditEvents);
    expect(after.map((event) => [event.seq, event.prev_hash, event.hash])).toEqual(
      before.map((event) => [event.seq, event.prev_hash, event.hash]),
    );
    expect(await db.app.withBusiness(who.business, verifyAuditChain)).toMatchObject({
      intact: true,
      length: 3,
    });

    const next = await write(db.app, who, {
      originConversationId: await conversationOf(db.app, who),
    });
    expect(next.seq).toBe('4');
    const chained = await db.app.withBusiness(who.business, readAuditEvents);
    expect(chained[3]?.prev_hash).toBe(before[2]?.hash);
    expect(await db.app.withBusiness(who.business, verifyAuditChain)).toMatchObject({
      intact: true,
      length: 4,
    });
  });
});

// eslint-disable-next-line max-lines-per-function -- one database, the origin's cases on it
describe.skipIf(serverUrl === undefined)('audit origin: on a database migrated from empty', () => {
  let db: FreshDatabase;
  let mine: Member;
  let theirs: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'auditorigin' });
    mine = await member(db.app, 'origin-mine');
    theirs = await member(db.app, 'origin-theirs');
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('audit origin: an origin is stored on the event and is in its hash', async () => {
    const conversation = await conversationOf(db.app, mine);
    const written = await write(db.app, mine, { originConversationId: conversation });
    const rows = await db.admin.execute<{
      readonly origin: string | null;
      readonly hash: string;
      readonly with_origin: string;
      readonly without: string;
    }>(
      `select a.origin_conversation_id::text as origin, a.hash,
              public.audit_event_hash(a.prev_hash, a.business_id, a.seq, a.occurred_at, a.actor_id,
                a.command, a.operation_id, a.outcome, a.refusal_code, a.subject_record_id,
                a.payload_digest, a.attempted, a.origin_conversation_id) as with_origin,
              public.audit_event_hash(a.prev_hash, a.business_id, a.seq, a.occurred_at, a.actor_id,
                a.command, a.operation_id, a.outcome, a.refusal_code, a.subject_record_id,
                a.payload_digest, a.attempted, null) as without
         from public.audit_events a where a.business_id = $1 and a.seq = $2`,
      [mine.business, written.seq],
    );
    expect(rows[0]?.origin).toBe(conversation);
    expect(rows[0]?.hash).toBe(rows[0]?.with_origin);
    expect(rows[0]?.hash).not.toBe(rows[0]?.without);
    expect(await db.app.withBusiness(mine.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });

  it('audit origin: another business’s conversation or a made-up id is refused and writes nothing', async () => {
    const foreign = await conversationOf(db.app, theirs);
    const length = async (): Promise<number> =>
      (await db.app.withBusiness(mine.business, readAuditEvents)).length;
    const before = await length();
    await expect(write(db.app, mine, { originConversationId: foreign })).rejects.toThrow();
    await expect(write(db.app, mine, { originConversationId: randomUUID() })).rejects.toThrow();
    expect(await length()).toBe(before);
    expect(await db.app.withBusiness(mine.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });

  it('audit origin: an event without an origin hashes exactly as before 0199', async () => {
    const written = await write(db.app, mine);
    const rows = await db.admin.execute<{ readonly hash: string; readonly recomputed: string }>(
      `select a.hash,
              encode(sha256(convert_to(
                coalesce(a.prev_hash, '') || '|' || a.business_id::text || '|' || a.seq::text || '|' ||
                to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
                a.actor_id::text || '|' || a.command || '|' || coalesce(a.operation_id, '') || '|' ||
                a.outcome || '|' || coalesce(a.refusal_code, '') || '|' ||
                coalesce(a.subject_record_id::text, '') || '|' || a.payload_digest || '|' ||
                coalesce(a.attempted::text, ''), 'utf8')), 'hex') as recomputed
         from public.audit_events a where a.business_id = $1 and a.seq = $2`,
      [mine.business, written.seq],
    );
    expect(rows[0]?.hash).toBe(rows[0]?.recomputed);
  });
});
