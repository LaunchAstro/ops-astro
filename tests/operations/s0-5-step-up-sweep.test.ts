// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's step-up sweep (TR-SEC2-5, TR-A2-14, TR-A5-1): the gate stays shut
// until every real money command refuses a stale sign-in while the money
// step-up setting is on.
//
// The money set is C59's (`isMoneyKey`: every `billing` key, `offer:decide`,
// `mandate:manage`, `spend:decide`), and the commands in it are read from the
// catalogue, never listed by hand. `SWEPT` is the one hand-kept list, and the
// closed-world case holds it to the catalogue both ways, so a money command
// declared later fails here until it joins, and a name that has left the money
// set fails until it is taken out. Each one is driven through the real API
// with a token whose second factor is past C59's sixty minutes, and with one
// that never gave a factor; both are refused `STEP_UP_REQUIRED` and write
// nothing. The same body then runs on a fresh sign-in, so the refusal is the
// step-up's and not the body's. C59's seeded money stand-in is proved in
// `tests/identity/c59-second-factor-commands.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  declarationOf,
  type CommandDeclaration,
} from '../../packages/core-wire/src/index.ts';
import {
  isMoneyKey,
  MONEY_STEP_UP_SETTING,
  readBusinessSetting,
} from '../../packages/core-records/src/index.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl, tokenFor } from '../acceptance/world.ts';

/**
 * The money commands this sweep proves. A money command declared later joins here:
 * the four-eyes threshold is `spend:decide` (MP-2-11, owner line 71).
 */
const SWEPT: readonly string[] = [
  'budget.top_up',
  'budget.record_outcome',
  'budget.write_off',
  'settings.set_four_eyes_threshold',
];

/**
 * The owner's sixty minutes (28 September 2026), written here rather than read
 * from `STEP_UP_WINDOW_SECONDS`, so a widened window fails the sweep.
 */
const OWNER_WINDOW_SECONDS = 60 * 60;

/** A refusal writes its audit event and its operation row, and nothing else. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

/** Where the hand-kept list and the catalogue's money set disagree, each way. */
function sweepGaps(
  surface: readonly CommandDeclaration[],
  swept: readonly string[],
): { readonly missing: string[]; readonly extra: string[] } {
  const money: readonly string[] = surface
    .filter((one) => isMoneyKey(one.collection, one.action))
    .map((one) => one.name);
  return {
    missing: money.filter((name) => !swept.includes(name)),
    extra: swept.filter((name) => !money.includes(name)),
  };
}

describe('S0-5 step-up sweep (closed world)', () => {
  it('S0-5 step-up sweep (closed world): the sweep names every catalogue command holding a money key, and nothing else', () => {
    expect(sweepGaps(COMMAND_SURFACE, SWEPT)).toEqual({ missing: [], extra: [] });
  });

  it('S0-5 step-up sweep (closed world): a planted money command with no entry fails, and so does an entry that holds no money key', () => {
    const planted = {
      ...declarationOf('settings.set_client_sign_off'),
      name: 'planted.spend',
      collection: 'spend',
      action: 'decide',
    } as unknown as CommandDeclaration;
    expect(sweepGaps([...COMMAND_SURFACE, planted], SWEPT).missing).toEqual(['planted.spend']);
    expect(sweepGaps(COMMAND_SURFACE, [...SWEPT, 'task.create']).extra).toEqual(['task.create']);
  });
});

const serverMissing = serverUrl === undefined;

if (serverMissing) {
  console.warn('S0-5 step-up sweep: DATABASE_URL is unset, so the database cases did not run.');
}

let harness: Harness;

const admin = async <T>(sql: string): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql)) as T[];

/** Each public table's rows as one digest, read past row security on the owner's connection. */
async function fingerprint(): Promise<ReadonlyMap<string, string>> {
  const tables = await admin<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
  );
  const union = tables
    .map(
      ({ name }) =>
        `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${name} t`,
    )
    .join(' union all ');
  const rows = await admin<{ name: string; digest: string }>(union);
  return new Map(rows.map((row) => [row.name, row.digest]));
}

const wroteBetween = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] =>
  [...after.keys()].filter(
    (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
  );

beforeAll(async () => {
  if (serverMissing) return;
  harness = await createHarness('s05stepup');
}, 180_000);

afterAll(async () => await harness?.close());

describe.skipIf(serverMissing)('S0-5 step-up sweep', () => {
  it('S0-5 step-up sweep: with the setting on, a stale sign-in is refused STEP_UP_REQUIRED on every money command and writes nothing; a fresh one runs', async () => {
    const { world } = harness;
    const setting = await world.db.app.withBusiness(
      world.alpha,
      async (tx) => await readBusinessSetting(tx, MONEY_STEP_UP_SETTING),
    );
    expect(setting?.value).toBe(true);

    const now = Math.floor(Date.now() / 1000);
    const stale = {
      'factor past the window': await tokenFor(world.ada.subject, {
        secondFactor: true,
        signedInAt: now - OWNER_WINDOW_SECONDS - 60,
      }),
      'no second factor': await tokenFor(world.ada.subject),
    };
    const money = COMMAND_SURFACE.filter((one) => isMoneyKey(one.collection, one.action));
    expect(money.map((one) => one.name).toSorted()).toEqual([...SWEPT].toSorted());

    const wrong: string[] = [];
    for (const declaration of money) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, each its own digest
      const prepared = await harness.positiveBody(declaration);
      if ('exception' in prepared) {
        wrong.push(`${declaration.name}: no positive body (${prepared.exception})`);
        continue;
      }
      for (const [how, token] of Object.entries(stale)) {
        // oxlint-disable-next-line no-await-in-loop
        const before = await fingerprint();
        // oxlint-disable-next-line no-await-in-loop
        const answer = await harness.asPerson(declaration.name, prepared.body, 'alpha', { token });
        // oxlint-disable-next-line no-await-in-loop
        const wrote = wroteBetween(before, await fingerprint());
        if (answer.code !== 'STEP_UP_REQUIRED' || answer.status !== 403 || wrote.length > 0) {
          wrong.push(
            `${declaration.name} (${how}): ${answer.status} ${answer.code}, wrote [${wrote.join(', ')}]`,
          );
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      const fresh = await harness.asPerson(declaration.name, prepared.body);
      if (fresh.code !== 'ok')
        wrong.push(`${declaration.name} (fresh): ${fresh.status} ${fresh.code}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
