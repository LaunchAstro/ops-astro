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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    expect(answer).toEqual({ ok: true, days: [], earlier: false });
  });
}

function isolationCases(): void {
  it('another business: its canary task is never found, in the days, a count or the flag', async () => {
    const answer = await search(w.ada, 'bravo canary');
    expect(days(answer)).toEqual({ ok: true, days: [], earlier: false });
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
