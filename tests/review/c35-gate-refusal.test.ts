// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): opening a review and asking its capture take in client material, so the
// catalogue classes both `client-data`. On an installation holding real data with a gate
// item open, each is refused `GATE_SHUT` in plain words, naming the open item, and writes
// nothing. The world is a fresh database, so the installation's mode is its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { COMMAND_EFFECTS, classOf } from '../../packages/core-wire/src/index.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 gate: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35gate');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/**
 * Real data with one item open. The one-way trigger lets the installation go real
 * only with every item done, so each is recorded first and phone alerts reopened
 * after, the state an item reopened after the move leaves.
 */
async function shutGateOnPhoneAlerts(): Promise<void> {
  const admin = w.world.db.admin;
  const items = GATE_ITEMS.map((item) => gateRecordBody(item));
  await admin.execute('update ops.installation set operator_business_id = $1', [w.world.business]);
  await admin.execute(
    `insert into ops.gate_items (item, evidence, statement)
     select * from unnest($1::text[], $2::text[], $3::text[]) on conflict (item) do nothing`,
    [
      items.map((one) => one['item']),
      items.map((one) => one['evidence']),
      items.map((one) => one['statement'] ?? null),
    ],
  );
  await admin.execute("update ops.installation set mode = 'real'");
  await admin.execute("delete from ops.gate_items where item = 'phone-alerts'");
  expect(
    await admin.execute('select mode, open_items from public.first_client_readiness()'),
  ).toEqual([{ mode: 'real', open_items: ['phone-alerts'] }]);
}

/** Every row of the review tables, in every business, as one digest per table. */
const reviewState = async (): Promise<readonly unknown[]> =>
  await Promise.all(
    (['reviews', 'review_revisions', 'review_captures'] as const).map(
      async (table) =>
        await w.world.db.admin.execute(
          `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
             from public.${table} t`,
        ),
    ),
  );

describe.skipIf(serverUrl === undefined)('C35 the first-client gate', () => {
  it('with phone alerts reopened, review.open and review.capture are refused GATE_SHUT and change no review row', async () => {
    expect(classOf(COMMAND_EFFECTS['review.open'])).toBe('client-data');
    expect(classOf(COMMAND_EFFECTS['review.capture'])).toBe('client-data');
    const opened = detailOf(await w.open(w.ava));
    await shutGateOnPhoneAlerts();
    const attempts = [
      async () => await w.open(w.ava),
      async () => await w.capture(w.ava, opened['revisionId']),
    ];
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt is measured alone
      const before = await reviewState();
      // oxlint-disable-next-line no-await-in-loop
      const refused = await attempt();
      expect(isCommandRefusal(refused) && refused.code).toBe('GATE_SHUT');
      if (!isCommandRefusal(refused)) continue;
      expect(refused.names).toStrictEqual(['phone-alerts']);
      expect(refused.fixes.join(' ')).toMatch(/real client data/u);
      // oxlint-disable-next-line no-await-in-loop
      expect(await reviewState()).toStrictEqual(before);
    }
  });
});
