// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2014): a new revision, the decision on it and Astra's review of it take in client
// material, so the catalogue classes each `client-data`. On an installation holding real
// data with a gate item open, each is refused `GATE_SHUT`, naming the open item, and writes
// nothing. The world is a fresh database, so the installation's mode is its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { COMMAND_EFFECTS, classOf } from '../../packages/core-wire/src/index.ts';
import type { DataEffects } from '../../packages/core-wire/src/data-effects-types.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X gate: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xgate');
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
    [
      'reviews',
      'review_revisions',
      'review_captures',
      'review_decisions',
      'review_astra_reviews',
    ].map(
      async (table) =>
        await w.world.db.admin
          .execute(
            `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
               from public.${table} t`,
          )
          .catch(String),
    ),
  );

const effectOf = (name: string): string => {
  const effects = (COMMAND_EFFECTS as Readonly<Record<string, DataEffects | undefined>>)[name];
  return effects === undefined ? 'undeclared' : classOf(effects);
};

describe.skipIf(serverUrl === undefined)('C35-X the first-client gate', () => {
  it('C35-X gate refusal', async () => {
    expect(effectOf('review.decide')).toBe('client-data');
    expect(effectOf('review.record_astra_review')).toBe('client-data');
    const opened = openedOf(detailOf(await w.open(w.fay)));
    await shutGateOnPhoneAlerts();
    const attempts = [
      async () => await w.open(w.fay),
      async () => await w.astra(w.ben, opened),
      async () => await w.decide(w.ben, opened),
    ];
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt is measured alone
      const before = await reviewState();
      // oxlint-disable-next-line no-await-in-loop
      const refused = await attempt();
      expect(isCommandRefusal(refused) && refused.code).toBe('GATE_SHUT');
      if (!isCommandRefusal(refused)) continue;
      expect(refused.names).toStrictEqual(['phone-alerts']);
      // oxlint-disable-next-line no-await-in-loop
      expect(await reviewState()).toStrictEqual(before);
    }
  });
});
