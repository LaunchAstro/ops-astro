// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger's read, `task.ledger` (MP-8-4, CS-8.9).
//
// The ledger is a view over `audit_events`: the applied writes to the
// business's live tasks, grouped by day in the reader's zone and paged by
// whole days (R49). These run the real read, through `executeRead`, against a
// fresh database; the events are the ones real commands wrote, except where a
// test needs days in the past, and those are inserted into the same table
// through the same chain trigger with the time set.
//
// Isolation makes three real crossings, each with its status checked: another
// business, a client of this business standing on one shared task, and a
// person holding a live delegation of one task. The client concept proper
// (another client in the same business) waits on SL09's U18 (SL10 LEANS-ON).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('MP-8-4 ledger read: DATABASE_URL is unset, so nothing below ran.');
}

type Command = Parameters<typeof executeCommand>[4];

/** Bravo's titles and keys: never in any answer alpha's readers get. */
const CANARY = `BRAVO-CANARY-${randomUUID()}`;

/** Whatever came back, as an object a key can be looked for in. */
const refusalOf = (value: unknown) => value as { code: string; names: readonly string[] };

/** The ledger's answer, or the test fails naming the refusal it got instead. */
function days(answer: object): TaskLedgerResult {
  if (isCommandRefusal(answer)) throw new Error(`task.ledger refused ${answer.code}`);
  return answer as TaskLedgerResult;
}

describe.skipIf(serverUrl === undefined)('MP-8-4 the ledger read', () => {
  let db: FreshDatabase;
  let alpha: string;
  let bravo: string;
  let gamma: string;
  /** Reads and writes alpha's tasks, and may delegate a read. */
  let ada: Member;
  /** A member of alpha with no grant. */
  let noah: Member;
  /** A member of alpha holding only ada's delegation of one task. */
  let dele: Member;
  /** Reads and writes bravo's tasks. */
  let bea: Member;
  /** Reads and writes gamma's tasks; gamma holds the dated events. */
  let gus: Member;
  let alphaTask: string;
  let alphaRevision: number;
  let alphaKey: string;
  let bravoTask: string;
  let gammaTask: string;

  const ledger = async (
    business: string,
    who: Member,
    body: Readonly<Record<string, unknown>> = { timeZone: 'UTC' },
  ) =>
    await executeRead(db.app, business, who.presented, {
      read: 'task.ledger',
      ...body,
    } as ReadRequest);

  const run = async (business: string, who: Member, body: Record<string, unknown>) => {
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

  const create = async (business: string, who: Member, title: string) => {
    const made = await run(business, who, { command: 'task.create', fields: { title } });
    if (made.recordId === null) throw new Error('task.create made nothing');
    return { recordId: made.recordId, revision: made.revision ?? 0 };
  };

  const recordOf = async (business: string, recordId: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly key: string; readonly revision: string }>(
        'select txt_1 as key, revision::text as revision from records where id = $1',
        [recordId],
      );
      return { key: rows[0]?.key ?? '', revision: Number(rows[0]?.revision) };
    });

  /** An applied write at a set time, through the chain like any other. */
  const plant = async (business: string, who: Member, recordId: string, at: string) =>
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `insert into audit_events
           (business_id, id, occurred_at, actor_id, command, operation_id, outcome,
            subject_record_id, payload_digest, seq, hash)
         values ($1, $2, $3::timestamptz, $4, 'task.update', $5, 'applied', $6, $7, 1, $7)`,
        [tx.businessId, randomUUID(), at, who.actorId, randomUUID(), recordId, '0'.repeat(64)],
      );
    });

  const ledgerAudit = async (business: string) =>
    await db.app.withBusiness(business, async (tx) =>
      (await readAuditEvents(tx)).filter((event) => event.command === 'task.ledger'),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'mp84' });
    alpha = await insertBusiness(db.app, 'alpha');
    bravo = await insertBusiness(db.app, 'bravo');
    gamma = await insertBusiness(db.app, 'gamma');
    await Promise.all(
      [alpha, bravo, gamma].map(async (business) => await installSpine(db.app, business)),
    );
    ada = await enrol(db.app, alpha, 'Ada Lovelace');
    noah = await enrol(db.app, alpha, 'Noah');
    dele = await enrol(db.app, alpha, 'Dele');
    bea = await enrol(db.app, bravo, 'Bea');
    gus = await enrol(db.app, gamma, 'Gus');
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

    const made = await create(alpha, ada, 'the ledger subject');
    alphaTask = made.recordId;
    alphaRevision = made.revision;
    alphaKey = (await recordOf(alpha, alphaTask)).key;

    // Ada's read is delegable, and she hands Dele a read of this one task.
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
        scope: { kind: 'record', id: alphaTask },
        collection: 'task',
        action: 'read',
        parentGrantId: root.value,
        grantedByActorId: ada.actorId,
      });
      if (!delegated.ok) throw new Error(`delegation refused ${delegated.refusal.code}`);
    });

    const bravoMade = await create(bravo, bea, CANARY);
    bravoTask = bravoMade.recordId;
    // Bravo has older days than alpha, so a leak would show in `earlier` too.
    await plant(bravo, bea, bravoTask, '2025-03-01T12:00:00Z');
    await plant(bravo, bea, bravoTask, '2025-03-02T12:00:00Z');

    gammaTask = (await create(gamma, gus, 'the dated task')).recordId;
    for (let day = 1; day <= 8; day += 1) {
      // eslint-disable-next-line no-await-in-loop -- one event at a time; the chain is shared
      await plant(gamma, gus, gammaTask, `2026-01-0${day}T02:00:00Z`);
    }
    // Two more on 5 January, so a day with three events is never split.
    await plant(gamma, gus, gammaTask, '2026-01-05T09:00:00Z');
    await plant(gamma, gus, gammaTask, '2026-01-05T20:00:00Z');
    // 20:00 UTC on 6 January is 7 January in Brisbane, so a page before the
    // 7th there must leave it out even though UTC calls it the 6th.
    await plant(gamma, gus, gammaTask, '2026-01-06T20:00:00Z');
  }, 120_000);

  afterAll(async () => await db?.drop());

  describe('MP-8-4 a view over the events table', () => {
    it('lists applied writes with who and when, and not reads, replays, refusals or trashed tasks', async () => {
      const update = {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: alphaTask,
        expectedRevision: alphaRevision,
        fields: { title: 'the ledger subject, renamed' },
      };
      const revision = (await run(alpha, ada, update)).revision;
      // The same write sent again is a replay: audited against the task, and
      // not a second change to it.
      await run(alpha, ada, update);
      const replays = await db.app.withBusiness(alpha, async (tx) =>
        (await readAuditEvents(tx)).filter((event) => event.outcome === 'replayed'),
      );
      expect(replays.map((event) => event.subject_record_id)).toStrictEqual([alphaTask]);
      // A read of the same task, and a refused write: neither happened to it.
      await executeRead(db.app, alpha, ada.presented, { read: 'task.read', recordId: alphaTask });
      const stale = await executeCommand(db.app, alpha, ada.presented, 'api', {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: alphaTask,
        expectedRevision: alphaRevision,
        fields: { title: 'stale' },
      } as Command);
      expect(isCommandRefusal(stale)).toBe(true);
      expect(revision).toBe(alphaRevision + 1);

      // A task that was written to and then trashed leaves the ledger whole.
      const gone = await create(alpha, ada, 'a task that goes');
      await run(alpha, ada, {
        command: 'task.trash',
        recordId: gone.recordId,
        expectedRevision: gone.revision,
      });

      const answer = days(await ledger(alpha, ada));
      expect(answer.days).toHaveLength(1);
      const events = answer.days[0]?.events ?? [];
      expect(events.map((event) => event.operation)).toStrictEqual(['task.update', 'task.create']);
      for (const event of events) {
        expect(event.actorName).toBe('Ada Lovelace');
        expect(event.task).toStrictEqual({ key: alphaKey, title: 'the ledger subject, renamed' });
        expect(Number.isNaN(Date.parse(event.at))).toBe(false);
      }
      expect(JSON.stringify(answer).includes(gone.recordId)).toBe(false);
      expect(JSON.stringify(answer).includes('a task that goes')).toBe(false);
    });
  });

  describe('MP-8-4 paging', () => {
    it('walks whole days, seven to a page, newest first, and says when there are no more', async () => {
      const first = days(await ledger(gamma, gus));
      // Today's create, then the seven newest planted days.
      expect(first.days.map((day) => day.day).slice(1)).toStrictEqual([
        '2026-01-08',
        '2026-01-07',
        '2026-01-06',
        '2026-01-05',
        '2026-01-04',
        '2026-01-03',
      ]);
      expect(first.days).toHaveLength(7);
      expect(first.earlier).toBe(true);

      const second = days(await ledger(gamma, gus, { timeZone: 'UTC', before: '2026-01-03' }));
      expect(second.days.map((day) => day.day)).toStrictEqual(['2026-01-02', '2026-01-01']);
      expect(second.earlier).toBe(false);
    });

    it('never splits a day, and orders its events newest first', async () => {
      const page = days(await ledger(gamma, gus, { timeZone: 'UTC', before: '2026-01-06' }));
      const fifth = page.days.find((day) => day.day === '2026-01-05');
      expect(fifth?.events.map((event) => event.at)).toStrictEqual([
        '2026-01-05T20:00:00.000Z',
        '2026-01-05T09:00:00.000Z',
        '2026-01-05T02:00:00.000Z',
      ]);
    });

    it("groups by the reader's zone, so an event moves across midnight with it", async () => {
      // 20:00 UTC on 5 January is 06:00 on the 6th in Brisbane (+10).
      const page = days(
        await ledger(gamma, gus, { timeZone: 'Australia/Brisbane', before: '2026-01-07' }),
      );
      expect(page.days[0]?.day).toBe('2026-01-06');
      expect(page.days[0]?.events.map((event) => event.at)).toStrictEqual([
        '2026-01-06T02:00:00.000Z',
        '2026-01-05T20:00:00.000Z',
      ]);
      expect(page.days[1]?.events.map((event) => event.at)).toStrictEqual([
        '2026-01-05T09:00:00.000Z',
        '2026-01-05T02:00:00.000Z',
      ]);
    });
  });

  describe('MP-8-4 malformed operands', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['no zone', {}, 'timeZone'],
      ['a zone that is not one', { timeZone: 'Mars/Olympus_Mons' }, 'timeZone'],
      ['a zone carrying quotes', { timeZone: "UTC'; select 1; --" }, 'timeZone'],
      ['a zone in the wrong case', { timeZone: 'australia/brisbane ' }, 'timeZone'],
      ['a zone that is a number', { timeZone: 10 }, 'timeZone'],
      ['a day that is not a day', { timeZone: 'UTC', before: '2026-02-30' }, 'before'],
      ['a day in another shape', { timeZone: 'UTC', before: '26-1-1' }, 'before'],
      ['a day with a time on it', { timeZone: 'UTC', before: '2026-01-01T00:00:00Z' }, 'before'],
      ['a day that is a number', { timeZone: 'UTC', before: 20260101 }, 'before'],
      // A real ISO day the database has no year for.
      ['a day in year zero', { timeZone: 'UTC', before: '0000-01-01' }, 'before'],
    ];

    it.each(cases)(
      'refuses %s, naming the operand, and audits the refusal',
      async (_, body, name) => {
        const before = (await ledgerAudit(alpha)).length;
        const answer = await ledger(alpha, ada, body);
        expect(isCommandRefusal(answer) ? [answer.code, answer.names] : answer).toStrictEqual([
          'FIELD_VALUE_INVALID',
          [name],
        ]);
        const events = (await ledgerAudit(alpha)).slice(before);
        expect(events.map((event) => [event.outcome, event.refusal_code])).toStrictEqual([
          ['refused', 'FIELD_VALUE_INVALID'],
        ]);
      },
    );
  });

  describe('MP-8-4 malformed operands, before the grant', () => {
    it('refuses a zone of the wrong shape before asking for a grant, as every read checks its body first', async () => {
      const answer = await ledger(alpha, noah, { timeZone: "UTC'; select 1; --" });
      expect(isCommandRefusal(answer) ? [answer.code, answer.names] : answer).toStrictEqual([
        'FIELD_VALUE_INVALID',
        ['timeZone'],
      ]);
    });
  });

  describe('MP-8-4 isolation', () => {
    const leaks = (answer: unknown): boolean => {
      const text = JSON.stringify(answer);
      return [CANARY, bravoTask].some((canary) => text.includes(canary));
    };

    it("never shows another business's events, in the days, their count or the earlier flag", async () => {
      const answer = days(await ledger(alpha, ada));
      expect(leaks(answer)).toBe(false);
      // Bravo's March 2025 days would make this true.
      expect(answer.earlier).toBe(false);
      expect(answer.days.flatMap((day) => day.events).length).toBe(2);
      // Bravo's own reader still sees them: the crossing is real.
      const own = days(await ledger(bravo, bea));
      expect(JSON.stringify(own).includes(CANARY)).toBe(true);
    });

    it('answers a reader of another business in the refusal alpha gives, and names nothing of bravo', async () => {
      const answer = await ledger(alpha, bea, { timeZone: 'UTC', before: '2025-03-03' });
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
      expect(leaks(answer)).toBe(false);
    });

    it('refuses a member with no task read grant, and returns no rows', async () => {
      const answer = await ledger(alpha, noah);
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect('days' in refusalOf(answer)).toBe(false);
    });

    it('refuses a person whose live delegation covers one task, and leaves that task readable', async () => {
      const task = await executeRead(db.app, alpha, dele.presented, {
        read: 'task.read',
        recordId: alphaTask,
      });
      expect(isCommandRefusal(task) ? task.code : 'answered').toBe('answered');
      const answer = await ledger(alpha, dele);
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect('days' in refusalOf(answer)).toBe(false);
    });

    it('tells a client standing on one shared task that there is no ledger', async () => {
      const client = await shareWithClient(db.app, alpha, ada, alphaTask);
      const task = await executeRead(db.app, alpha, client.presented, {
        read: 'task.read',
        recordId: alphaTask,
      });
      expect(isCommandRefusal(task) ? task.code : 'answered').toBe('answered');
      const answer = await ledger(alpha, client);
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
      expect('days' in refusalOf(answer)).toBe(false);
    });

    it('lists comments to staff, and tells a reader who is not staff there is no ledger', async () => {
      await run(alpha, ada, {
        command: 'task.comment',
        recordId: alphaTask,
        expectedRevision: (await recordOf(alpha, alphaTask)).revision,
        body: 'an internal note',
        audience: 'internal',
      });
      const inside = days(await ledger(alpha, ada));
      expect(inside.days[0]?.events.map((event) => event.operation)).toContain('task.comment');

      // A member of alpha whose role is none of the internal ones, holding a
      // business-wide task read: `task.read` shows such a reader the shared
      // view, which carries no history, so the ledger (all history) is not theirs.
      const guest = await enrol(db.app, alpha, 'Guest');
      await db.app.withBusiness(alpha, async (tx) => {
        await tx.query(`update memberships set role_key = 'guest' where person_id = $1`, [
          guest.personId,
        ]);
        await grantTo(tx, guest, 'read');
      });
      const shared = await executeRead(db.app, alpha, guest.presented, {
        read: 'task.read',
        recordId: alphaTask,
      });
      expect('sharedTask' in shared).toBe(true);
      const answer = await ledger(alpha, guest);
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
      expect(JSON.stringify(answer).includes(alphaKey)).toBe(false);
    });
  });
});
