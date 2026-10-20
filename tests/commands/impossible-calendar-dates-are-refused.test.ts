// SPDX-License-Identifier: AGPL-3.0-only
//
// A date the calendar does not have is refused as the caller's mistake, never
// rolled into another day or handed to the column to fault on. `Date.parse`
// reads 30 February as 2 March and takes the year zero, which Postgres does not
// have: an incident found on such a day would start its assessment clock on a
// different day, or fault, and a credential would expire a day later than the
// one asked for.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { INFORMATION_KINDS } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'calendar_dates' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  ada = await enrol(db.app, alpha, 'Ada Lane');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'privacy');
    await grantTo(tx, ada, 'write', WHOLE_BUSINESS, false, 'credential');
    await grantTo(tx, ada, 'write', WHOLE_BUSINESS);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const send = async (body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
  await executeCommand(db.app, alpha, ada.presented, 'api', body as never);

const answerOf = (answer: CommandResult): unknown =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : 'applied';

const incident = (foundAt: string) => ({
  command: 'privacy.record_incident',
  operationId: randomUUID(),
  whatHappened: 'A list was sent to the wrong client.',
  foundAt,
  foundBy: 'Ada Lane',
  affected: 'One client.',
  informationKinds: [INFORMATION_KINDS[0]],
});

async function incidents(): Promise<number> {
  const [row] = await db.admin.execute<{ readonly n: number }>(
    'select count(*)::int as n from public.privacy_incidents where business_id = $1',
    [alpha],
  );
  return row?.n ?? -1;
}

it.skipIf(serverUrl === undefined).each([
  ['30 February', '2026-02-30T09:00:00Z'],
  ['31 April', '2026-04-31T09:00:00+10:00'],
  ['the year zero', '0000-06-01T00:00:00Z'],
])('an incident found on %s is refused and records nothing', async (_day, foundAt) => {
  const before = await incidents();
  expect(answerOf(await send(incident(foundAt)))).toStrictEqual({
    code: 'FIELD_VALUE_INVALID',
    names: ['foundAt'],
  });
  expect(await incidents()).toBe(before);
});

it.skipIf(serverUrl === undefined)('an incident found on a real day is recorded', async () => {
  expect(answerOf(await send(incident('2026-02-28T09:00:00Z')))).toBe('applied');
});

/** Day 31 of the next month that has 30 days, a day no calendar has, within the credential limit. */
function thirtyFirstOfAShortMonth(): string {
  const at = new Date();
  for (let ahead = 1; ahead <= 3; ahead += 1) {
    const month = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + ahead, 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
    if (last.getUTCDate() === 30) {
      const mm = String(month.getUTCMonth() + 1).padStart(2, '0');
      return `${month.getUTCFullYear()}-${mm}-31T00:00:00Z`;
    }
  }
  throw new Error('no 30-day month in the next three');
}

it.skipIf(serverUrl === undefined)(
  'a credential asked to expire on a day the month does not have is refused',
  async () => {
    const answer = await send({
      command: 'credential.issue',
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'write' }],
      purpose: 'expires on a day that is not there',
      expiresAt: thirtyFirstOfAShortMonth(),
    });
    expect(answerOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names: ['expiresAt'] });
  },
);
