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

describe.skipIf(serverUrl === undefined)('C35 the first-client gate', () => {
  it('C35 gate refusal', async () => {
    expect(classOf(COMMAND_EFFECTS['review.open'])).toBe('client-data');
    expect(classOf(COMMAND_EFFECTS['review.capture'])).toBe('client-data');
    const opened = detailOf(await w.open(w.ava));
    const admin = w.world.db.admin;
    await admin.execute('update ops.installation set operator_business_id = $1', [
      w.world.business,
    ]);
    await admin.execute("update ops.installation set mode = 'real'");
    const counts = async () =>
      await Promise.all(
        (['reviews', 'review_revisions', 'review_captures'] as const).map(
          async (table) => await w.count(table, w.world.business),
        ),
      );
    const before = await counts();
    for (const refused of [await w.open(w.ava), await w.capture(w.ava, opened['revisionId'])]) {
      expect(isCommandRefusal(refused) && refused.code).toBe('GATE_SHUT');
      if (!isCommandRefusal(refused)) continue;
      expect(refused.names).toContain('phone-alerts');
      expect(refused.fixes.join(' ')).toMatch(/real client data/u);
    }
    expect(await counts()).toStrictEqual(before);
  });
});
