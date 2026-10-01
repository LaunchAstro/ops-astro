// SPDX-License-Identifier: AGPL-3.0-only
//
// The activity ledger's read, `task.ledger` (MP-8-4, CS-8.9): malformed
// operands. Each is refused naming the operand and audited as refused, and a
// zone of the wrong shape is refused before any grant is asked for. The same
// world as `mp-8-4-ledger-read.test.ts`, on a fresh database of its own; split
// from it for the lint ratchet (CQ-12), the cases unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Member } from '../commands/fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  ledgerAuditOn,
  ledgerOf,
  openLedgerWorld,
  type LedgerWorld,
} from './mp-8-4-ledger-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('MP-8-4 ledger operands: DATABASE_URL is unset, so nothing below ran.');
}

let w: LedgerWorld;

const ledger = async (business: string, who: Member, body?: Readonly<Record<string, unknown>>) =>
  await ledgerOf(w.db, business, who, body);
const ledgerAudit = async (business: string) => await ledgerAuditOn(w.db, business);

describe.skipIf(serverUrl === undefined)('MP-8-4 the ledger read', () => {
  beforeAll(async () => {
    w = await openLedgerWorld();
  }, 120_000);

  afterAll(async () => await w?.db.drop());

  describe('MP-8-4 malformed operands', malformedCases);
  describe('MP-8-4 malformed operands, before the grant', beforeGrantCases);
});

/** Each malformed operand refused, named and audited. */
function malformedCases(): void {
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
      const before = (await ledgerAudit(w.alpha)).length;
      const answer = await ledger(w.alpha, w.ada, body);
      expect(isCommandRefusal(answer) ? [answer.code, answer.names] : answer).toStrictEqual([
        'FIELD_VALUE_INVALID',
        [name],
      ]);
      const events = (await ledgerAudit(w.alpha)).slice(before);
      expect(events.map((event) => [event.outcome, event.refusal_code])).toStrictEqual([
        ['refused', 'FIELD_VALUE_INVALID'],
      ]);
    },
  );
}

/** The body is checked before any grant is asked for. */
function beforeGrantCases(): void {
  it('refuses a zone of the wrong shape before asking for a grant, as every read checks its body first', async () => {
    const answer = await ledger(w.alpha, w.noah, { timeZone: "UTC'; select 1; --" });
    expect(isCommandRefusal(answer) ? [answer.code, answer.names] : answer).toStrictEqual([
      'FIELD_VALUE_INVALID',
      ['timeZone'],
    ]);
  });
}
