// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11's two windows: both declared `settings:manage`, which no agent
// holds, and the cases that need a world of their own. An agent under a live
// delegation from a `settings:manage` holder writes neither, and 0061 hands the
// rows a business installed before this change to their commands, keeping the
// values the business chose. The rest are in `mp-2-11-business-windows.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import { agentWorld, codeOf } from './agent-fixture.ts';

const CONVERSATION = 'settings.set_conversation_window';
const RETENTION = 'settings.set_retention_window';
const WINDOWS = ['conversation_window_days', 'retention_window_days'] as const;

const serverUrl = databaseUrlFromEnvironment();

it('MP-2-11 settings:manage refused: both windows are settings:manage, which no agent holds', () => {
  for (const command of [CONVERSATION, RETENTION] as const) {
    const declared = declarationOf(command);
    expect([declared.collection, declared.action, declared.agent], command).toEqual([
      'settings',
      'manage',
      'never',
    ]);
  }
});

let upgraded: EmptyDatabase | undefined;
afterAll(async () => await upgraded?.drop());

it.skipIf(serverUrl === undefined)(
  'MP-2-11 isolation: an agent under a live delegation from a settings:manage holder writes neither window',
  async () => {
    const world = await agentWorld('mp211win', 'mp211win');
    try {
      await world.db.app.withBusiness(
        world.business,
        async (tx) => await installBusinessSettings(tx),
      );
      const owner = await world.decider('owner');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, owner, 'manage', WHOLE_BUSINESS, true, 'settings');
      });
      const picked = await world.pickUp(owner, 'mp-2-11 windows agent work');
      for (const command of [CONVERSATION, RETENTION]) {
        const body = { command, operationId: `win-agent-${randomUUID()}`, value: 45 };
        // oxlint-disable-next-line no-await-in-loop
        expect(codeOf(await world.asAgent(body as never, picked.credential)), command).toBe(
          'DELEGATION_EXCLUDES_OPERATION',
        );
      }
      const values = await world.db.app.withBusiness(world.business, async (tx) => [
        (await readBusinessSetting(tx, WINDOWS[0]))?.value,
        (await readBusinessSetting(tx, WINDOWS[1]))?.value,
      ]);
      expect(values).toEqual([30, 30]);
    } finally {
      await world.drop();
    }
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'MP-2-11 business rows: 0061 hands both windows to their commands and keeps their values',
  async () => {
    const onDisk = readMigrations('migrations');
    upgraded = await createEmptyDatabase({ part: 'mp211win0061' });
    const before = onDisk.filter((migration) => migration.version.slice(0, 4) < '0061');
    await applyMigrations(upgraded.admin, before);
    const business = await insertBusiness(upgraded.app, 'early');
    await upgraded.app.withBusiness(business, async (tx) => await installBusinessSettings(tx));
    // What an install before this change wrote: both windows generic, one
    // already moved by the business.
    await upgraded.admin.execute(
      `update business_settings set write_mode = 'generic', owning_operation = null
        where key in ('conversation_window_days', 'retention_window_days')`,
    );
    await upgraded.admin.execute(
      `update business_settings set value = '45'::jsonb, revision = 3
        where key = 'retention_window_days'`,
    );
    await upgraded.closeSessions();
    await migrate(upgraded.admin, 'migrations');
    const rows = await upgraded.admin.execute<Record<string, unknown>>(
      `select key, write_mode, owning_operation, value, revision from business_settings
        where key in ('conversation_window_days', 'retention_window_days') order by key`,
    );
    expect(rows.map((row) => Object.values(row))).toEqual([
      [WINDOWS[0], 'operation', [CONVERSATION], 30, 1],
      [WINDOWS[1], 'operation', [RETENTION], 45, 3],
    ]);
  },
  180_000,
);
