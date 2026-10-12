// SPDX-License-Identifier: AGPL-3.0-only
//
// Text the stores cannot hold, a NUL or half of a split character, is refused
// by name before it reaches Postgres, where a text column raises on a NUL and
// the driver writes U+FFFD for a lone surrogate. Two entry points the door's
// free-operand check did not reach: availability, which has its own
// transaction, and a preference value, a json operand.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { setOwnAvailability } from '../../packages/core-commands/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, installSpine, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE_SURROGATE = String.fromCodePoint(0xd8_00);

let db: FreshDatabase;
let alpha: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'unstorable_text' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function availabilityRows(person: Member): Promise<number> {
  const [row] = await db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from public.person_availability
      where business_id = $1 and person_id = $2`,
    [alpha, person.personId],
  );
  return row?.n ?? 0;
}

async function refusedAvailability(person: Member): Promise<readonly string[]> {
  const rows = await db.admin.execute<{ readonly code: string }>(
    `select refusal_code as code from public.audit_events
      where business_id = $1 and actor_id = $2 and command = 'availability.set'
        and outcome = 'refused'`,
    [alpha, person.actorId],
  );
  return rows.map((row) => row.code);
}

describe.skipIf(serverUrl === undefined)('text the stores cannot hold', () => {
  it('an availability reason holding a NUL or a lone surrogate is refused, audited, and sets nothing', async () => {
    const ada = await enrol(db.app, alpha, `ada-${randomUUID().slice(0, 8)}`);
    for (const reason of [`Out${NUL}side`, `Away ${LONE_SURROGATE}`]) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      const set = await setOwnAvailability(db.app, alpha, ada.presented, {
        state: 'away',
        reason,
      });
      expect(set).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID', names: ['reason'] });
    }
    expect(await availabilityRows(ada)).toBe(0);
    expect(await refusedAvailability(ada)).toStrictEqual([
      'FIELD_VALUE_INVALID',
      'FIELD_VALUE_INVALID',
    ]);
  });

  it('a preference value holding a NUL is refused by name and saves nothing', async () => {
    const bo = await enrol(db.app, alpha, `bo-${randomUUID().slice(0, 8)}`);
    const saved = await executeCommand(db.app, alpha, bo.presented, 'api', {
      command: 'preference.save',
      operationId: randomUUID(),
      preference: 'columns.widths',
      value: { [`title${NUL}`]: 120 },
    });
    expect(saved).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID', names: ['value'] });
    const stored = await db.admin.execute(
      `select 1 from public.person_preferences where business_id = $1 and person_id = $2`,
      [alpha, bo.personId],
    );
    expect(stored).toHaveLength(0);
  });
});
