// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11's This business group: the conversation and retention windows.
//
// Both rows have been installed since 0009, read by `settings.read`, and the
// retention window by `task.purge`; nothing could write either (issue 70). They
// are now owned by a command each, as the other three settings are, under
// `settings:manage`, against the revision the caller read, and audited.
//
// The bounds are the owner's (C122-1, 14 September): a conversation body lives
// thirty days from last activity, configurable with a floor of seven days and a
// ceiling at the business's own work-retention window. The retention window is
// a whole number of days, zero or more, the purge's own rule. The ceiling spans
// two rows, so each command locks both before it compares: two administrators
// moving one window each can never leave the conversation window longer than
// the retention window.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { setBusinessSetting } from '../../packages/core-commands/src/commands/settings-write.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  enrol,
  grantTo,
  installSpine,
  shareWithClient,
  WHOLE_BUSINESS,
  type Member,
} from './fixture.ts';
import { agentWorld, codeOf } from './agent-fixture.ts';

const CONVERSATION = 'settings.set_conversation_window';
const RETENTION = 'settings.set_retention_window';
type WindowCommand = typeof CONVERSATION | typeof RETENTION;
const KEY: Readonly<Record<WindowCommand, string>> = {
  [CONVERSATION]: 'conversation_window_days',
  [RETENTION]: 'retention_window_days',
};

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let bravo: string;
/** settings:manage in alpha. */
let mia: Member;
/** Reads settings in alpha, manages nothing. */
let rex: Member;
/** settings:manage in bravo. */
let bea: Member;
/** Outside alpha, standing on one task mia shared. */
let client: Member;

const set = async (
  member: Member,
  command: WindowCommand,
  value: unknown,
  expectedRevision?: number,
  businessId = alpha,
): Promise<string> => {
  const outcome = await executeCommand(db.app, businessId, member.presented, 'api', {
    command,
    operationId: `win-${randomUUID()}`,
    value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  } as never);
  return isCommandRefusal(outcome) ? outcome.code : 'applied';
};

const row = async (command: WindowCommand, businessId = alpha) =>
  await db.app.withBusiness(businessId, async (tx) => await readBusinessSetting(tx, KEY[command]));

/** Save at the row's revision, read it back through `settings.read`, then be refused stale. */
const savesAgainstItsRevision = async (command: WindowCommand, value: number): Promise<void> => {
  const before = await row(command);
  expect(await set(mia, command, value, before?.revision)).toBe('applied');
  const read = await executeRead(db.app, alpha, mia.presented, { read: 'settings.read' });
  if (!('settings' in read)) throw new Error('settings.read refused');
  const seen = read.settings.find((setting) => setting.key === KEY[command]);
  expect([seen?.value, seen?.revision]).toEqual([value, (before?.revision ?? 0) + 1]);
  expect(await set(mia, command, value + 1, before?.revision)).toBe('VERSION_STALE');
  expect((await row(command))?.value).toBe(value);
};

/** Put both windows back where a case expects them, through the commands themselves. */
const windows = async (conversation: number, retention: number): Promise<void> => {
  // Retention first when it grows, conversation first when it shrinks, so the
  // ceiling holds at every step.
  if (retention >= ((await row(RETENTION))?.value as number)) {
    expect(await set(mia, RETENTION, retention)).toBe('applied');
    expect(await set(mia, CONVERSATION, conversation)).toBe('applied');
  } else {
    expect(await set(mia, CONVERSATION, conversation)).toBe('applied');
    expect(await set(mia, RETENTION, retention)).toBe('applied');
  }
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'mp211win' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  for (const business of [alpha, bravo]) {
    // oxlint-disable-next-line no-await-in-loop
    await installSpine(db.app, business);
    // oxlint-disable-next-line no-await-in-loop
    await db.app.withBusiness(business, async (tx) => await installBusinessSettings(tx));
  }
  mia = await enrol(db.app, alpha, 'mia');
  rex = await enrol(db.app, alpha, 'rex');
  bea = await enrol(db.app, bravo, 'bea');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, mia, 'read');
    await grantTo(tx, mia, 'write');
    await grantTo(tx, mia, 'share');
    await grantTo(tx, mia, 'read', WHOLE_BUSINESS, false, 'settings');
    await grantTo(tx, mia, 'manage', WHOLE_BUSINESS, false, 'settings');
    await grantTo(tx, rex, 'read', WHOLE_BUSINESS, false, 'settings');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bea, 'read', WHOLE_BUSINESS, false, 'settings');
    await grantTo(tx, bea, 'manage', WHOLE_BUSINESS, false, 'settings');
  });
  const made = await executeCommand(db.app, alpha, mia.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'Shared brochure' },
  } as never);
  if (isCommandRefusal(made) || made.recordId === null) throw new Error('task.create refused');
  client = await shareWithClient(db.app, alpha, mia, made.recordId);
}, 120_000);

afterAll(async () => await db?.drop());

describe('MP-2-11 business rows, the declarations', () => {
  it('MP-2-11 settings:manage refused: both windows are settings:manage, which no agent holds', () => {
    for (const command of [CONVERSATION, RETENTION]) {
      const declared = declarationOf(command as never);
      expect([declared.collection, declared.action, declared.agent], command).toEqual([
        'settings',
        'manage',
        'never',
      ]);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-2-11 business rows: the two windows', () => {
  it('MP-2-11 business rows: each window saves against its revision, settings.read hands it back, and a stale revision is refused', async () => {
    await savesAgainstItsRevision(RETENTION, 90);
    await savesAgainstItsRevision(CONVERSATION, 14);
  });

  it('MP-2-11 business rows: the conversation window is seven days or more and never longer than the retention window', async () => {
    await windows(30, 60);
    for (const value of [6, 0, -1, 7.5, '14', null, true]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await set(mia, CONVERSATION, value), String(value)).toBe('FIELD_VALUE_INVALID');
    }
    expect(await set(mia, CONVERSATION, 61)).toBe('FIELD_VALUE_INVALID');
    expect(await set(mia, CONVERSATION, 60)).toBe('applied');
    expect(await set(mia, CONVERSATION, 7)).toBe('applied');
    expect((await row(CONVERSATION))?.value).toBe(7);
  });

  it('MP-2-11 business rows: the retention window is whole days and never shorter than the conversation window', async () => {
    await windows(20, 60);
    for (const value of [-1, 30.5, '45', null, false]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await set(mia, RETENTION, value), String(value)).toBe('FIELD_VALUE_INVALID');
    }
    expect(await set(mia, RETENTION, 19)).toBe('FIELD_VALUE_INVALID');
    expect(await set(mia, RETENTION, 20)).toBe('applied');
    expect((await row(RETENTION))?.value).toBe(20);
  });

  it('MP-2-11 business rows: two administrators at once never leave the conversation window longer than the retention window', async () => {
    await windows(30, 60);
    const context = { session: { actorId: mia.actorId } } as never;
    const second = connect(db.appUrl, { source: 'runtime' });
    try {
      const { held, release } = gate();
      // The first lengthens the conversation window to 50 and stays open; the
      // second shortens retention to 40 on another connection meanwhile.
      const first = db.app.withBusiness(alpha, async (tx) => {
        const outcome = await setBusinessSetting(tx, context, CONVERSATION as never, 50);
        await held;
        return outcome;
      });
      await pause(100);
      const other = second.withBusiness(
        alpha,
        async (tx) => await setBusinessSetting(tx, context, RETENTION as never, 40),
      );
      await pause(200);
      release();
      const outcomes = await Promise.all([first, other]);
      expect(
        outcomes.map((outcome) => ('refusal' in outcome ? outcome.refusal.code : 'applied')),
      ).toEqual(['applied', 'FIELD_VALUE_INVALID']);
      const [conversation, retention] = [await row(CONVERSATION), await row(RETENTION)];
      expect([conversation?.value, retention?.value]).toEqual([50, 60]);
    } finally {
      await second.close();
    }
  });

  it('MP-2-11 settings:manage refused: a settings reader without manage writes neither window', async () => {
    const before = [await row(CONVERSATION), await row(RETENTION)];
    expect(await set(rex, CONVERSATION, 21)).toBe('SCOPE_NOT_GRANTED');
    expect(await set(rex, RETENTION, 120)).toBe('SCOPE_NOT_GRANTED');
    expect([await row(CONVERSATION), await row(RETENTION)]).toEqual(before);
  });

  it('MP-2-11 audit read-back: each window change, applied or refused, is on the audit chain', async () => {
    await windows(30, 60);
    const retention = await row(RETENTION);
    const operations = [`win-a-${randomUUID()}`, `win-r-${randomUUID()}`];
    for (const [operationId, expectedRevision] of [
      [operations[0], retention?.revision],
      [operations[1], (retention?.revision ?? 1) - 1],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await executeCommand(db.app, alpha, mia.presented, 'api', {
        command: RETENTION,
        operationId,
        value: 75,
        expectedRevision,
      } as never);
    }
    await db.app.withBusiness(alpha, async (tx) => {
      const events = (await readAuditEvents(tx)).filter((event) =>
        operations.includes(event.operation_id ?? ''),
      );
      expect(events.map((event) => [event.command, event.outcome, event.refusal_code])).toEqual([
        [RETENTION, 'applied', null],
        [RETENTION, 'refused', 'VERSION_STALE'],
      ]);
      expect((await verifyAuditChain(tx)).intact).toBe(true);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-2-11 isolation: the two windows', () => {
  it('MP-2-11 isolation: another business writes and reads only its own windows', async () => {
    const alphaBefore = [await row(CONVERSATION), await row(RETENTION)];
    expect(await set(bea, RETENTION, 365, undefined, bravo)).toBe('applied');
    expect((await row(RETENTION, bravo))?.value).toBe(365);
    expect(await set(bea, RETENTION, 366)).toBe('SCOPE_NOT_GRANTED');
    expect(await set(bea, CONVERSATION, 8)).toBe('SCOPE_NOT_GRANTED');
    expect(await set(mia, RETENTION, 1, undefined, bravo)).toBe('SCOPE_NOT_GRANTED');
    expect([await row(CONVERSATION), await row(RETENTION)]).toEqual(alphaBefore);
    expect((await row(RETENTION, bravo))?.value).toBe(365);
    const read = await executeRead(db.app, alpha, bea.presented, { read: 'settings.read' });
    expect('settings' in read).toBe(false);
    expect(JSON.stringify(read)).not.toContain('365');
  });

  it('MP-2-11 isolation: a client of this business on a shared task writes and reads neither window', async () => {
    const before = [await row(CONVERSATION), await row(RETENTION)];
    expect(await set(client, CONVERSATION, 9)).toBe('SCOPE_NOT_GRANTED');
    expect(await set(client, RETENTION, 400)).toBe('SCOPE_NOT_GRANTED');
    expect([await row(CONVERSATION), await row(RETENTION)]).toEqual(before);
    const read = await executeRead(db.app, alpha, client.presented, { read: 'settings.read' });
    expect('settings' in read).toBe(false);
  });

  it('MP-2-11 isolation: an agent under a live delegation from a settings:manage holder writes neither window', async () => {
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
        (await readBusinessSetting(tx, KEY[CONVERSATION]))?.value,
        (await readBusinessSetting(tx, KEY[RETENTION]))?.value,
      ]);
      expect(values).toEqual([30, 30]);
    } finally {
      await world.drop();
    }
  }, 60_000);
});

describe.skipIf(serverUrl === undefined)(
  'MP-2-11 business rows: a business installed before',
  () => {
    let upgraded: EmptyDatabase;
    afterAll(async () => await upgraded?.drop());

    it('MP-2-11 business rows: 0060 hands both windows to their commands and keeps their values', async () => {
      const onDisk = readMigrations('migrations');
      upgraded = await createEmptyDatabase({ part: 'mp211win0060' });
      await applyMigrations(
        upgraded.admin,
        onDisk.filter((migration) => migration.version.slice(0, 4) < '0060'),
      );
      const business = await insertBusiness(upgraded.app, 'early');
      await upgraded.app.withBusiness(business, async (tx) => await installBusinessSettings(tx));
      // What an install before this change wrote: both windows generic, one
      // already moved by the business.
      await upgraded.admin.execute(
        `update business_settings
          set write_mode = 'generic', owning_operation = null
        where key in ('conversation_window_days', 'retention_window_days')`,
      );
      await upgraded.admin.execute(
        `update business_settings set value = '45'::jsonb, revision = 3
        where key = 'retention_window_days'`,
      );
      await upgraded.closeSessions();
      await migrate(upgraded.admin, 'migrations');
      const rows = await upgraded.admin.execute<{
        readonly key: string;
        readonly write_mode: string;
        readonly owning_operation: readonly string[] | null;
        readonly value: unknown;
        readonly revision: number;
      }>(
        `select key, write_mode, owning_operation, value, revision from business_settings
        where key in ('conversation_window_days', 'retention_window_days') order by key`,
      );
      expect(rows).toEqual([
        {
          key: 'conversation_window_days',
          write_mode: 'operation',
          owning_operation: [CONVERSATION],
          value: 30,
          revision: 1,
        },
        {
          key: 'retention_window_days',
          write_mode: 'operation',
          owning_operation: [RETENTION],
          value: 45,
          revision: 3,
        },
      ]);
    }, 180_000);
  },
);

/** A promise the test resolves when it chooses, to hold a transaction open. */
function gate(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
