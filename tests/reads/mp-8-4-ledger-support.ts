// SPDX-License-Identifier: AGPL-3.0-only
//
// The world `mp-8-4-ledger-read.test.ts` reads the ledger in (MP-8-4): three
// businesses on a fresh database, their members and grants, one delegation of
// one task, and dated events planted through the chain trigger. Split from the
// suite for the lint ratchet (CQ-12); what it builds is unchanged.

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import {
  isCommandRefusal,
  type CommandRefusal,
} from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';

export type Command = Parameters<typeof executeCommand>[4];

/** A command's answer when it applied. */
type Applied = Exclude<Awaited<ReturnType<typeof executeCommand>>, CommandRefusal>;

/** Bravo's titles and keys: never in any answer alpha's readers get. */
export const CANARY: string = `BRAVO-CANARY-${randomUUID()}`;

/** Whatever came back, as an object a key can be looked for in. */
export const refusalOf = (value: unknown) => value as { code: string; names: readonly string[] };

/** The ledger's answer, or the test fails naming the refusal it got instead. */
export function days(answer: object): TaskLedgerResult {
  if (isCommandRefusal(answer)) throw new Error(`task.ledger refused ${answer.code}`);
  return answer as TaskLedgerResult;
}

export interface LedgerWorld {
  readonly db: FreshDatabase;
  readonly alpha: string;
  readonly bravo: string;
  readonly gamma: string;
  /** Reads and writes alpha's tasks, and may delegate a read. */
  readonly ada: Member;
  /** A member of alpha with no grant. */
  readonly noah: Member;
  /** A member of alpha holding only ada's delegation of one task. */
  readonly dele: Member;
  /** Reads and writes bravo's tasks. */
  readonly bea: Member;
  /** Reads and writes gamma's tasks; gamma holds the dated events. */
  readonly gus: Member;
  readonly alphaTask: string;
  readonly alphaRevision: number;
  readonly alphaKey: string;
  readonly bravoTask: string;
  readonly gammaTask: string;
}

export const ledgerOf = async (
  db: FreshDatabase,
  business: string,
  who: Member,
  body?: Readonly<Record<string, unknown>>,
): Promise<Awaited<ReturnType<typeof executeRead>>> =>
  await executeRead(db.app, business, who.presented, {
    read: 'task.ledger',
    ...(body ?? { timeZone: 'UTC' }),
  } as ReadRequest);

export const runOn = async (
  db: FreshDatabase,
  business: string,
  who: Member,
  body: Record<string, unknown>,
): Promise<Applied> => {
  const outcome = await executeCommand(db.app, business, who.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as Command);
  if (isCommandRefusal(outcome)) {
    throw new Error(
      `${String(body['command'])} refused ${outcome.code} ${outcome.names.join(',')}`,
    );
  }
  return outcome;
};

export const createOn = async (
  db: FreshDatabase,
  business: string,
  who: Member,
  title: string,
): Promise<{ recordId: NonNullable<Applied['recordId']>; revision: number }> => {
  const made = await runOn(db, business, who, { command: 'task.create', fields: { title } });
  if (made.recordId === null) throw new Error('task.create made nothing');
  return { recordId: made.recordId, revision: made.revision ?? 0 };
};

export const recordOn = async (
  db: FreshDatabase,
  business: string,
  recordId: string,
): Promise<{ key: string; revision: number }> =>
  await db.app.withBusiness(business, async (tx) => {
    const rows = await tx.query<{ readonly key: string; readonly revision: string }>(
      'select txt_1 as key, revision::text as revision from records where id = $1',
      [recordId],
    );
    return { key: rows[0]?.key ?? '', revision: Number(rows[0]?.revision) };
  });

/** An applied write at a set time, through the chain like any other. */
const plant = async (
  db: FreshDatabase,
  business: string,
  who: Member,
  recordId: string,
  at: string,
) =>
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(
      `insert into audit_events
         (business_id, id, occurred_at, actor_id, command, operation_id, outcome,
          subject_record_id, payload_digest, seq, hash)
       values ($1, $2, $3::timestamptz, $4, 'task.update', $5, 'applied', $6, $7, 1, $7)`,
      [tx.businessId, randomUUID(), at, who.actorId, randomUUID(), recordId, '0'.repeat(64)],
    );
  });

export const ledgerAuditOn = async (
  db: FreshDatabase,
  business: string,
): Promise<Awaited<ReturnType<typeof readAuditEvents>>> =>
  await db.app.withBusiness(business, async (tx) =>
    (await readAuditEvents(tx)).filter((event) => event.command === 'task.ledger'),
  );

/** The three businesses, their members, and each member's grants. */
async function people(db: FreshDatabase) {
  const alpha = await insertBusiness(db.app, 'alpha');
  const bravo = await insertBusiness(db.app, 'bravo');
  const gamma = await insertBusiness(db.app, 'gamma');
  await Promise.all(
    [alpha, bravo, gamma].map(async (business) => await installSpine(db.app, business)),
  );
  const ada = await enrol(db.app, alpha, 'Ada Lovelace');
  const noah = await enrol(db.app, alpha, 'Noah');
  const dele = await enrol(db.app, alpha, 'Dele');
  const bea = await enrol(db.app, bravo, 'Bea');
  const gus = await enrol(db.app, gamma, 'Gus');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'write');
    await grantTo(tx, ada, 'comment');
    await grantTo(tx, ada, 'share');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bea, 'read');
    await grantTo(tx, bea, 'write');
  });
  await db.app.withBusiness(gamma, async (tx) => {
    await grantTo(tx, gus, 'read');
    await grantTo(tx, gus, 'write');
  });
  return { alpha, bravo, gamma, ada, noah, dele, bea, gus };
}

/** Ada's read is delegable, and she hands Dele a read of this one task. */
async function delegate(db: FreshDatabase, alpha: string, ada: Member, dele: Member, task: string) {
  await db.app.withBusiness(alpha, async (tx) => {
    const root = await issueGrant(tx, [], {
      subject: { kind: 'person', id: ada.personId },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'read',
      canDelegate: true,
      parentGrantId: null,
      grantedByActorId: ada.actorId,
    });
    if (!root.ok) throw new Error(`root read refused ${root.refusal.code}`);
    const delegated = await issueGrant(tx, [{ kind: 'person', id: ada.personId }], {
      subject: { kind: 'person', id: dele.personId },
      scope: { kind: 'record', id: task },
      collection: 'task',
      action: 'read',
      parentGrantId: root.value,
      grantedByActorId: ada.actorId,
    });
    if (!delegated.ok) throw new Error(`delegation refused ${delegated.refusal.code}`);
  });
}

/** Gamma's dated task: eight days in January, three events on the 5th. */
async function datedDays(db: FreshDatabase, gamma: string, gus: Member): Promise<string> {
  const gammaTask = (await createOn(db, gamma, gus, 'the dated task')).recordId;
  for (let day = 1; day <= 8; day += 1) {
    // eslint-disable-next-line no-await-in-loop -- one event at a time; the chain is shared
    await plant(db, gamma, gus, gammaTask, `2026-01-0${day}T02:00:00Z`);
  }
  // Two more on 5 January, so a day with three events is never split.
  await plant(db, gamma, gus, gammaTask, '2026-01-05T09:00:00Z');
  await plant(db, gamma, gus, gammaTask, '2026-01-05T20:00:00Z');
  // 20:00 UTC on 6 January is 7 January in Brisbane, so a page before the
  // 7th there must leave it out even though UTC calls it the 6th.
  await plant(db, gamma, gus, gammaTask, '2026-01-06T20:00:00Z');
  return gammaTask;
}

export async function openLedgerWorld(): Promise<LedgerWorld> {
  const db = await createFreshDatabase({ part: 'mp84' });
  const who = await people(db);
  const made = await createOn(db, who.alpha, who.ada, 'the ledger subject');
  const alphaKey = (await recordOn(db, who.alpha, made.recordId)).key;
  await delegate(db, who.alpha, who.ada, who.dele, made.recordId);

  const bravoTask = (await createOn(db, who.bravo, who.bea, CANARY)).recordId;
  // Bravo has older days than alpha, so a leak would show in `earlier` too.
  await plant(db, who.bravo, who.bea, bravoTask, '2025-03-01T12:00:00Z');
  await plant(db, who.bravo, who.bea, bravoTask, '2025-03-02T12:00:00Z');

  const gammaTask = await datedDays(db, who.gamma, who.gus);
  return {
    db,
    ...who,
    alphaTask: made.recordId,
    alphaRevision: made.revision,
    alphaKey,
    bravoTask,
    gammaTask,
  };
}
