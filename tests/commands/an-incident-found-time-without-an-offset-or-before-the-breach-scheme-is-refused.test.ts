// SPDX-License-Identifier: AGPL-3.0-only
//
// When an incident was found starts its assessment clock, so the time has to
// name one instant wherever the server runs. A time with no offset would be
// read in the host's zone and land hours away from what was meant; a time
// before the Notifiable Data Breaches scheme began (22 February 2018) is a
// typing mistake, not a day 0. Both are refused as the caller's mistake and
// record nothing; the same instant written in any offset is recorded alike.

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
  db = await createFreshDatabase({ part: 'incident_found_at' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  ada = await enrol(db.app, alpha, 'Ada Lane');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'privacy');
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const send = async (foundAt: string): Promise<CommandResult> =>
  await executeCommand(db.app, alpha, ada.presented, 'api', {
    command: 'privacy.record_incident',
    operationId: randomUUID(),
    whatHappened: 'A list was sent to the wrong client.',
    foundAt,
    foundBy: 'Ada Lane',
    affected: 'One client.',
    informationKinds: [INFORMATION_KINDS[0]],
  } as never);

const answerOf = (answer: CommandResult): unknown =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : 'applied';

async function foundTimes(): Promise<string[]> {
  const rows = await db.admin.execute<{ readonly found: string }>(
    `select to_char(found_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as found
       from public.privacy_incidents where business_id = $1 order by recorded_at`,
    [alpha],
  );
  return rows.map((row) => row.found);
}

it.skipIf(serverUrl === undefined).each([
  ['with no offset', '2026-10-01T09:00:00'],
  ['with no offset and fractions', '2026-10-01T09:00:00.250'],
  ['before the breach scheme began', '2018-02-21T09:00:00Z'],
  ['in the first century', '0101-06-01T00:00:00Z'],
])('an incident found at a time %s is refused and records nothing', async (_why, foundAt) => {
  const before = await foundTimes();
  expect(answerOf(await send(foundAt))).toStrictEqual({
    code: 'FIELD_VALUE_INVALID',
    names: ['foundAt'],
  });
  expect(await foundTimes()).toStrictEqual(before);
});

it.skipIf(serverUrl === undefined)(
  'one instant written in UTC or with an offset is recorded as the same day 0',
  async () => {
    const before = await foundTimes();
    expect(answerOf(await send('2026-10-01T09:00:00Z'))).toBe('applied');
    expect(answerOf(await send('2026-10-01T19:00:00+10:00'))).toBe('applied');
    expect(answerOf(await send('2018-02-22T00:00:00+11:00'))).toBe('applied');
    expect((await foundTimes()).slice(before.length)).toStrictEqual([
      '2026-10-01T09:00:00Z',
      '2026-10-01T09:00:00Z',
      '2018-02-21T13:00:00Z',
    ]);
  },
);
