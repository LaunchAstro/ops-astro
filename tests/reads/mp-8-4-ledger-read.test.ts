// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger's read, `task.ledger` (MP-8-4, CS-8.9).
//
// The ledger is a view over `audit_events`: the applied writes to the
// business's live tasks, grouped by day in the reader's zone and paged by
// whole days (R49). These run the real read, through `executeRead`, against a
// fresh database; the events are the ones real commands wrote, except where a
// test needs days in the past, and those are inserted into the same table
// through the same chain trigger with the time set (`mp-8-4-ledger-support.ts`).
//
// Isolation makes three real crossings, each with its status checked: another
// business, a client of this business standing on one shared task, and a
// person holding a live delegation of one task. The client concept proper
// (another client in the same business) waits on SL09's U18 (SL10 LEANS-ON).
//
// The cases run in order on one world: the isolation counts include the view
// case's writes. Each describe's cases are a named function below, for the
// lint ratchet (CQ-12); the malformed operands are `mp-8-4-ledger-operands.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  CANARY,
  createOn,
  days,
  ledgerOf,
  openLedgerWorld,
  recordOn,
  refusalOf,
  runOn,
  type Command,
  type LedgerWorld,
} from './mp-8-4-ledger-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('MP-8-4 ledger read: DATABASE_URL is unset, so nothing below ran.');
}

let w: LedgerWorld;

const ledger = async (business: string, who: Member, body?: Readonly<Record<string, unknown>>) =>
  await ledgerOf(w.db, business, who, body);
const run = async (business: string, who: Member, body: Record<string, unknown>) =>
  await runOn(w.db, business, who, body);
const create = async (business: string, who: Member, title: string) =>
  await createOn(w.db, business, who, title);
const recordOf = async (business: string, recordId: string) =>
  await recordOn(w.db, business, recordId);

/** Alpha's task, read by `who` through the task read, as the ledger's neighbour. */
const readTask = async (who: Member) =>
  await executeRead(w.db.app, w.alpha, who.presented, { read: 'task.read', recordId: w.alphaTask });

const leaks = (answer: unknown): boolean => {
  const text = JSON.stringify(answer);
  return [CANARY, w.bravoTask].some((canary) => text.includes(canary));
};

describe.skipIf(serverUrl === undefined)('MP-8-4 the ledger read', () => {
  beforeAll(async () => {
    w = await openLedgerWorld();
  }, 120_000);

  afterAll(async () => await w?.db.drop());

  describe('MP-8-4 a view over the events table', viewCases);
  describe('MP-8-4 paging', pagingCases);
  describe('MP-8-4 isolation', () => {
    isolationAcrossCases();
    isolationStandingCases();
  });
});

/** The ledger lists applied writes and nothing else. */
function viewCases(): void {
  it('lists applied writes with who and when, and not reads, replays, refusals or trashed tasks', async () => {
    const update = {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: w.alphaTask,
      expectedRevision: w.alphaRevision,
      fields: { title: 'the ledger subject, renamed' },
    };
    const revision = (await run(w.alpha, w.ada, update)).revision;
    // The same write sent again is a replay: audited against the task, and
    // not a second change to it.
    await run(w.alpha, w.ada, update);
    const replays = await w.db.app.withBusiness(w.alpha, async (tx) =>
      (await readAuditEvents(tx)).filter((event) => event.outcome === 'replayed'),
    );
    expect(replays.map((event) => event.subject_record_id)).toStrictEqual([w.alphaTask]);
    // A read of the same task, and a refused write: neither happened to it.
    await readTask(w.ada);
    const stale = await executeCommand(w.db.app, w.alpha, w.ada.presented, 'api', {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: w.alphaTask,
      expectedRevision: w.alphaRevision,
      fields: { title: 'stale' },
    } as Command);
    expect(isCommandRefusal(stale)).toBe(true);
    expect(revision).toBe(w.alphaRevision + 1);

    // A task that was written to and then trashed leaves the ledger whole.
    const gone = await create(w.alpha, w.ada, 'a task that goes');
    await run(w.alpha, w.ada, {
      command: 'task.trash',
      recordId: gone.recordId,
      expectedRevision: gone.revision,
    });

    const answer = days(await ledger(w.alpha, w.ada));
    expect(answer.days).toHaveLength(1);
    const events = answer.days[0]?.events ?? [];
    expect(events.map((event) => event.operation)).toStrictEqual(['task.update', 'task.create']);
    for (const event of events) {
      expect(event.actorName).toBe('Ada Lovelace');
      expect(event.task).toStrictEqual({ key: w.alphaKey, title: 'the ledger subject, renamed' });
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
    expect(JSON.stringify(answer).includes(gone.recordId)).toBe(false);
    expect(JSON.stringify(answer).includes('a task that goes')).toBe(false);
  });
}

/** Whole days, seven to a page, in the reader's zone. */
function pagingCases(): void {
  it('walks whole days, seven to a page, newest first, and says when there are no more', async () => {
    const first = days(await ledger(w.gamma, w.gus));
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

    const second = days(await ledger(w.gamma, w.gus, { timeZone: 'UTC', before: '2026-01-03' }));
    expect(second.days.map((day) => day.day)).toStrictEqual(['2026-01-02', '2026-01-01']);
    expect(second.earlier).toBe(false);
  });

  it('never splits a day, and orders its events newest first', async () => {
    const page = days(await ledger(w.gamma, w.gus, { timeZone: 'UTC', before: '2026-01-06' }));
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
      await ledger(w.gamma, w.gus, { timeZone: 'Australia/Brisbane', before: '2026-01-07' }),
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
}

/** Another business, a member with no grant, and a delegation of one task. */
function isolationAcrossCases(): void {
  it("never shows another business's events, in the days, their count or the earlier flag", async () => {
    const answer = days(await ledger(w.alpha, w.ada));
    expect(leaks(answer)).toBe(false);
    // Bravo's March 2025 days would make this true.
    expect(answer.earlier).toBe(false);
    expect(answer.days.flatMap((day) => day.events).length).toBe(2);
    // Bravo's own reader still sees them: the crossing is real.
    const own = days(await ledger(w.bravo, w.bea));
    expect(JSON.stringify(own).includes(CANARY)).toBe(true);
  });

  it('answers a reader of another business in the refusal alpha gives, and names nothing of bravo', async () => {
    const answer = await ledger(w.alpha, w.bea, { timeZone: 'UTC', before: '2025-03-03' });
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    expect(leaks(answer)).toBe(false);
  });

  it('refuses a member with no task read grant, and returns no rows', async () => {
    const answer = await ledger(w.alpha, w.noah);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect('days' in refusalOf(answer)).toBe(false);
  });

  it('refuses a person whose live delegation covers one task, and leaves that task readable', async () => {
    const task = await readTask(w.dele);
    expect(isCommandRefusal(task) ? task.code : 'answered').toBe('answered');
    const answer = await ledger(w.alpha, w.dele);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect('days' in refusalOf(answer)).toBe(false);
  });
}

/** A client on one shared task, and a member who is not staff. */
function isolationStandingCases(): void {
  it('tells a client standing on one shared task that there is no ledger', async () => {
    const client = await shareWithClient(w.db.app, w.alpha, w.ada, w.alphaTask);
    const task = await readTask(client);
    expect(isCommandRefusal(task) ? task.code : 'answered').toBe('answered');
    const answer = await ledger(w.alpha, client);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
    expect('days' in refusalOf(answer)).toBe(false);
  });

  it('lists comments to staff, and tells a reader who is not staff there is no ledger', async () => {
    await run(w.alpha, w.ada, {
      command: 'task.comment',
      recordId: w.alphaTask,
      expectedRevision: (await recordOf(w.alpha, w.alphaTask)).revision,
      body: 'an internal note',
      audience: 'internal',
    });
    const inside = days(await ledger(w.alpha, w.ada));
    expect(inside.days[0]?.events.map((event) => event.operation)).toContain('task.comment');

    // A member of alpha whose role is none of the internal ones, holding a
    // business-wide task read: `task.read` shows such a reader the shared
    // view, which carries no history, so the ledger (all history) is not theirs.
    const guest = await enrol(w.db.app, w.alpha, 'Guest');
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await tx.query(`update memberships set role_key = 'guest' where person_id = $1`, [
        guest.personId,
      ]);
      await grantTo(tx, guest, 'read');
    });
    const shared = await readTask(guest);
    expect('sharedTask' in shared).toBe(true);
    const answer = await ledger(w.alpha, guest);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
    expect(JSON.stringify(answer).includes(w.alphaKey)).toBe(false);
  });
}
