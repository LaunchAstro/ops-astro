// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger's search (MP-8-4, CS-8.9): `task.ledger` with `query`.
//
// The words are handed to C1's one scoped query service (`searchTasks`), and
// the ledger lists the events of the tasks it finds and nothing else; this
// read adds only its own reading of the hits, no second search (FG-O-2).
//
// Isolation makes three real crossings, each with its status checked and every
// body read whole: another business, whose canary task a search never finds;
// another client in the same business, whose reader holds one task and is
// refused the ledger whatever it searches; and a person holding a live
// delegation of one task, refused likewise.
//
// Past C1's cap: the ledger asks `searchTasks` for up to C1's bound of 500
// tasks, not the twenty ⌘K shows, and answers `more` when the reader's own
// matches lie past it. The three crossings are made again with more foreign
// matches than the bound, so a leak would show in `more` as well as the days.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import {
  CANARY,
  createOn,
  days,
  ledgerOf,
  openLedgerWorld,
  type LedgerWorld,
} from './mp-8-4-ledger-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('MP-8-4 ledger search: DATABASE_URL is unset, so nothing below ran.');
}

/** A word only the other client's task carries. */
const THEIR_CLIENT_WORD = 'nacreous';

let w: LedgerWorld;
/** Alpha's second task, the other client's. */
let theirTask: string;
/** Holds `task:read` on alpha's first task only: one client's reader. */
let ann: Member;

const search = async (who: Member, query: unknown, business = w.alpha) =>
  await ledgerOf(w.db, business, who, { timeZone: 'UTC', query });

const keysOf = (answer: Awaited<ReturnType<typeof search>>): readonly string[] =>
  days(answer).days.flatMap((day) => day.events.map((event) => event.task.key));

describe.skipIf(serverUrl === undefined)('MP-8-4 the ledger search', () => {
  beforeAll(async () => {
    w = await openLedgerWorld();
    theirTask = (await createOn(w.db, w.alpha, w.ada, `Boreal ${THEIR_CLIENT_WORD} invoice`))
      .recordId;
    ann = await enrol(w.db.app, w.alpha, 'Ann');
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, ann, 'read', { kind: 'record', id: w.alphaTask });
    });
  }, 120_000);

  afterAll(async () => await w?.db.drop());

  describe("MP-8-4 search runs on C1's one scoped query service", serviceCases);
  describe('MP-8-4 search isolation', isolationCases);
  describe('MP-8-4 search operand', operandCases);
  describe("MP-8-4 search past C1's cap", pastCapCases);
});

function serviceCases(): void {
  it('lists the events of the tasks a search finds, and none of any other task', async () => {
    const all = keysOf(await search(w.ada, null));
    expect(new Set(all).size).toBe(2);
    const found = keysOf(await search(w.ada, 'ledger subject'));
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([w.alphaKey]));
  });

  it('finds the same tasks `task.search` finds, by the same words', async () => {
    const hits = await executeRead(w.db.app, w.alpha, w.ada.presented, {
      read: 'task.search',
      query: 'bor',
    } as ReadRequest);
    const searched = 'hits' in hits ? hits.hits.map((hit) => hit.key) : [];
    expect(searched).toHaveLength(1);
    expect(new Set(keysOf(await search(w.ada, 'bor')))).toEqual(new Set(searched));
  });

  it('a search that finds nothing lists no day and offers no earlier ones', async () => {
    const answer = days(await search(w.ada, 'zzyzzx'));
    expect(answer).toEqual({ ok: true, days: [], earlier: false, more: false });
  });
}

function isolationCases(): void {
  it('another business: its canary task is never found, in the days, a count or the flag', async () => {
    const answer = await search(w.ada, 'bravo canary');
    expect(days(answer)).toEqual({ ok: true, days: [], earlier: false, more: false });
    expect(JSON.stringify(answer)).not.toContain(w.bravoTask);
    // Bravo's own reader finds it: the crossing is real.
    const own = await search(w.bea, 'bravo canary', w.bravo);
    expect(JSON.stringify(own)).toContain(CANARY);
  });

  it("another client in the same business: one client's reader is refused, naming nothing of the other", async () => {
    const answer = await search(ann, THEIR_CLIENT_WORD);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    const body = JSON.stringify(answer);
    expect(body).not.toContain(THEIR_CLIENT_WORD);
    expect(body).not.toContain(theirTask);
    // The whole-business reader finds it: the crossing is real.
    expect(keysOf(await search(w.ada, THEIR_CLIENT_WORD))).toHaveLength(1);
  });

  it('a person under a live delegation of one task is refused, naming nothing', async () => {
    const answer = await search(w.dele, THEIR_CLIENT_WORD);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(answer)).not.toContain(THEIR_CLIENT_WORD);
  });
}

function operandCases(): void {
  it('refuses a query with no word in it, or of the wrong type, naming `query`', async () => {
    for (const query of ['', '   ', '*&|', 42, ['subject'], 'x'.repeat(201)]) {
      // eslint-disable-next-line no-await-in-loop -- one malformed body at a time
      const answer = await search(w.ada, query);
      expect([query, isCommandRefusal(answer) ? answer.names : 'answered']).toEqual([
        query,
        ['query'],
      ]);
    }
  });

  it('refuses a malformed query before asking for a grant', async () => {
    const answer = await search(w.noah, 42);
    expect(isCommandRefusal(answer) ? [answer.code, answer.names] : 'answered').toEqual([
      'FIELD_VALUE_INVALID',
      ['query'],
    ]);
  });
}

/** Copies of alpha's first task titled `<word> <n>`, `count` of them, keyed apart. */
async function copies(word: string, count: number): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      `insert into records (business_id, id, record_type_id, data)
       select r.business_id, gen_random_uuid(), r.record_type_id,
              r.data || jsonb_build_object('title', 'Copy ' || $3 || ' ' || n,
                                           'key', 'CP-' || $3 || '-' || n)
         from records r, generate_series(1, $4::int) n
        where r.business_id = $1 and r.id = $2`,
      [tx.businessId, w.alphaTask, word, count],
    );
  });
}

/** What a refusal may never carry past the cap: a hit, a day, a flag or a title. */
const NOTHING_FOUND = /"hits"|"days"|"more"|Copy|Acme|surplus|brimful/u;

/** Alpha's 25 tasks titled `Acme plenary <n>`, past ⌘K's twenty. */
const acme: string[] = [];

/** Exactly the bound of brimful in alpha, one past it of surplus, and foreign matches past both. */
async function seedPastCap(): Promise<void> {
  for (let n = 0; n < 25; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one task at a time; keys are sequential
    acme.push((await createOn(w.db, w.alpha, w.ada, `Acme plenary ${String(n)}`)).recordId);
  }
  await copies('brimful', 500);
  await copies('surplus', 501);
  for (let n = 0; n < 3; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one task at a time
    await createOn(w.db, w.bravo, w.bea, `${CANARY} brimful surplus ${String(n)}`);
  }
}

function pastCapCases(): void {
  beforeAll(seedPastCap, 180_000);
  pastCapReads();
  pastCapCrossings();
}

function pastCapReads(): void {
  it('lists the events of every matching task past twenty, and says there is no more', async () => {
    const answer = days(await search(w.ada, 'plenary'));
    expect(new Set(keysOf(answer)).size).toBe(25);
    expect(answer.more).toBe(false);
  });

  it("answers more when the reader's own matches lie past C1's bound of 500", async () => {
    const answer = days(await search(w.ada, 'surplus'));
    expect(answer.more).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });

  it("a limit sent to the ledger is not honoured: the bound is the server's", async () => {
    const answer = days(
      await ledgerOf(w.db, w.alpha, w.ada, { timeZone: 'UTC', query: 'plenary', limit: 5 }),
    );
    expect(new Set(keysOf(answer)).size).toBe(25);
    expect(answer.more).toBe(false);
  });
}

function pastCapCrossings(): void {
  it('another business: its matches past the bound never make more, nor enter the days', async () => {
    // Alpha holds exactly 500 brimful tasks and bravo three: only a leak makes more.
    const exact = await search(w.ada, 'brimful');
    expect(days(exact).more).toBe(false);
    expect(JSON.stringify(exact)).not.toContain(CANARY);
    // Bravo's reader searching alpha's 501 surplus finds only bravo's own three.
    const theirs = days(await search(w.bea, 'surplus', w.bravo));
    expect(theirs.more).toBe(false);
    expect(JSON.stringify(theirs)).not.toMatch(/Copy|CP-/u);
    // And asking in alpha's name is refused before any search.
    const crossed = await search(w.bea, 'surplus');
    expect(isCommandRefusal(crossed) ? crossed.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    expect(JSON.stringify(crossed)).not.toMatch(NOTHING_FOUND);
  });

  it("another client in the same business: one client's reader is refused, with no more, title, id or count", async () => {
    const answer = await search(ann, 'surplus');
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    const body = JSON.stringify(answer);
    expect(body).not.toMatch(NOTHING_FOUND);
    for (const id of acme) expect(body).not.toContain(id);
    expect(body).not.toMatch(/\b50[01]\b/u);
  });

  it('a person under a live delegation of one task is refused past the cap, with no more', async () => {
    const answer = await search(w.dele, 'surplus');
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(answer)).not.toMatch(NOTHING_FOUND);
  });
}

describe.skipIf(serverUrl === undefined)(
  'MP-8-4 search past the cap, over the real HTTP route',
  () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await createHarness('mp84capagent');
    }, 120_000);

    afterAll(async () => await harness?.close());

    it('an agent under a live delegation searching the ledger is refused, naming no title, id or more', async () => {
      const { subject, sibling, decided } = await harness.approvedReservation();
      const detail = decided.body['detail'] as Record<string, unknown>;
      const picked = await harness.asAgent('task.pickup', {
        reservationId: String(detail['reservationId']),
      });
      const credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
      const answer = await harness.asAgent(
        'task.ledger',
        { timeZone: 'UTC', query: 'sibling' },
        credential,
      );
      const body = JSON.stringify(answer.body);
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(body).not.toContain(sibling.id);
      expect(body).not.toContain(subject.id);
      expect(body).not.toMatch(/"days"|"more"|sibling/u);
    });
  },
);
