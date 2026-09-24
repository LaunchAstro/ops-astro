// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-RUNTIME-6 = R2-AUTHORITY-20: the 0025 cap-ceiling
// backstop must not pass when row security hides the cap at commit.
//
// 0025's deferred trigger runs at commit under whatever `app.business_id` the
// transaction holds then, and the application role may change that setting
// after its write. Cleared, or switched to another business, the claim on the
// cap finds no row, the ceiling reads NULL, `committed > NULL` is NULL and the
// over-ceiling commit went through. A ceiling that cannot be read is not room
// (RUNTIME.md, thermo O2): 0029 refuses it `budget_caps_ceiling` instead.
//
// Every write below is the application role's, inside `withBusiness`, never
// the owner's. The same cases run on a database migrated from empty and on
// one migrated to 0028, seeded, and then upgraded: fresh and upgraded behave
// the same, and the seeded rows survive the upgrade byte for byte.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
  type MigrationOutcome,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r2-dbtest-cap-fails-closed: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const LIMIT = 1000;
const THROUGH_0028 = (version: string): boolean => version.slice(0, 4) <= '0028';
const CEILING = { code: '23514', constraint_name: 'budget_caps_ceiling' };

const onDisk = readMigrations('migrations');

interface World {
  readonly db: EmptyDatabase;
  readonly business: BusinessId;
  readonly decider: Member;
  /** A business the setting can be switched to: real, and not the writer's. */
  readonly other: BusinessId;
}

async function openWorld(db: EmptyDatabase, key: string): Promise<World> {
  const business = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, business);
  const decider = await enrol(db.app, business, 'decider');
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action);
    }
  });
  const other = (await insertBusiness(db.app, `${key}-other`)) as BusinessId;
  return { db, business, decider, other };
}

/** A new AUD cap of 1000 in the world's business. */
async function newCap(w: World): Promise<string> {
  const capId = randomUUID();
  await w.db.app.withBusiness(w.business, async (tx) => {
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, $3, $4, 'AUD')`,
      [w.business, capId, `cap-${capId}`, LIMIT],
    );
  });
  return capId;
}

async function createTask(w: World): Promise<string> {
  const outcome = await executeCommand(w.db.app, w.business, w.decider.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: `fails closed ${randomUUID()}` },
  } as never);
  if (isCommandRefusal(outcome) || outcome.recordId === null) {
    throw new Error('task.create did not apply');
  }
  return outcome.recordId;
}

async function insertEnvelope(
  tx: TenantQuery,
  w: World,
  capId: string,
  taskId: string,
  held: number,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.task_envelopes
       (business_id, id, cap_id, task_id, maximum_minor, held_minor, currency)
     values ($1, $2, $3, $4, $5, $6, 'AUD')`,
    [w.business, id, capId, taskId, LIMIT * 4, held],
  );
  return id;
}

/** An envelope holding `held`, committed under a steady setting. */
async function envelope(w: World, capId: string, held: number): Promise<string> {
  const taskId = await createTask(w);
  return await w.db.app.withBusiness(
    w.business,
    async (tx) => await insertEnvelope(tx, w, capId, taskId, held),
  );
}

/** The cap's limit and committed total, read by the owner as text. */
async function capState(w: World, capId: string): Promise<string> {
  const [row] = await w.db.admin.execute<{ readonly state: string }>(
    `select c.currency || ' ' || c.limit_minor::text || ' ' ||
            coalesce((select sum(e.held_minor + e.actual_minor) from public.task_envelopes e
                       where e.business_id = c.business_id and e.cap_id = c.id), 0)::text as state
       from public.budget_caps c where c.business_id = $1 and c.id = $2`,
    [w.business, capId],
  );
  return row?.state ?? 'absent';
}

/**
 * The write the backstop judges, and the value its second step takes. Each
 * starts from a cap of 1000 holding 900 in one envelope. `over` passes the
 * ceiling; `within` stays under it.
 */
interface Write {
  readonly label: string;
  readonly over: number;
  readonly within: number;
  run(tx: TenantQuery, w: World, capId: string, envelopeId: string, to: number): Promise<void>;
}

const WRITES: readonly Write[] = [
  {
    label: 'an envelope inserted',
    over: 101,
    within: 100,
    async run(tx, w, capId, _envelopeId, to) {
      // The task is created before the transaction; the insert is the write.
      await insertEnvelope(tx, w, capId, pendingTask.get(capId) ?? '', to);
    },
  },
  {
    label: 'a hold raised',
    over: 1900,
    within: 1000,
    async run(tx, w, _capId, envelopeId, to) {
      await tx.query(
        `update public.task_envelopes set held_minor = $3 where business_id = $1 and id = $2`,
        [w.business, envelopeId, to],
      );
    },
  },
  {
    label: 'the limit lowered',
    over: 899,
    within: 900,
    async run(tx, w, capId, _envelopeId, to) {
      await tx.query(
        `update public.budget_caps set limit_minor = $3 where business_id = $1 and id = $2`,
        [w.business, capId, to],
      );
    },
  },
];

/** The task an insert case writes its envelope for, made outside its transaction. */
const pendingTask = new Map<string, string>();

/** How the setting stands at commit. */
const SETTINGS = [
  ['cleared', (_w: World): string => ''],
  ['switched to another business', (w: World): string => w.other],
] as const;

/** A cap of 1000 holding 900, and a task ready for an insert case. */
async function startingCap(
  w: World,
): Promise<{ readonly capId: string; readonly envelopeId: string }> {
  const capId = await newCap(w);
  const envelopeId = await envelope(w, capId, 900);
  pendingTask.set(capId, await createTask(w));
  return { capId, envelopeId };
}

/** The write, then the setting changed to `setting`, then commit. */
async function writeThenChange(
  w: World,
  write: Write,
  capId: string,
  envelopeId: string,
  to: number,
  setting: string | null,
): Promise<void> {
  await w.db.app.withBusiness(w.business, async (tx) => {
    await write.run(tx, w, capId, envelopeId, to);
    if (setting !== null) {
      await tx.query(`select set_config('app.business_id', $1, true)`, [setting]);
    }
  });
}

interface Built {
  readonly db: EmptyDatabase;
  readonly migration: MigrationOutcome;
  readonly seeded?: string;
  readonly seededAfter?: string;
}

async function fresh(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'failsclosedfresh' });
  return { db, migration: await applyMigrations(db.admin, onDisk) };
}

/** Every cap and envelope, as the owner reads them, in one string. */
async function seedSnapshot(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select (select string_agg(c::text, '|' order by c.id) from public.budget_caps c) || '#' ||
            (select string_agg(e::text, '|' order by e.id) from public.task_envelopes e) as all`,
  );
  return row?.all ?? '';
}

async function upgraded(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'failsclosedupgraded' });
  await applyMigrations(
    db.admin,
    onDisk.filter((m) => THROUGH_0028(m.version)),
  );
  // Valid rows written through the application role at 0028: a cap filled to
  // its ceiling across two envelopes, and one with room left.
  const w = await openWorld(db, 'seed-0028');
  const full = await newCap(w);
  await envelope(w, full, 400);
  await envelope(w, full, 600);
  const roomy = await newCap(w);
  await envelope(w, roomy, 250);
  const seeded = await seedSnapshot(db);
  const migration = await migrate(db.admin, 'migrations');
  return { db, migration, seeded, seededAfter: await seedSnapshot(db) };
}

describe.skipIf(serverUrl === undefined).each([
  ['fresh', fresh],
  ['upgraded from 0028', upgraded],
] as const)('the cap ceiling fails closed on a %s database', (label, build) => {
  let built: Built;
  let w: World;

  beforeAll(async () => {
    built = await build();
    w = await openWorld(built.db, `failsclosed-${label.replaceAll(' ', '-')}`);
  }, 120_000);

  afterAll(async () => {
    await built?.db.drop();
  });

  it('applies every migration once, the upgrade only those after 0028', () => {
    const through = onDisk.filter((m) => THROUGH_0028(m.version)).map((m) => m.version);
    const after = onDisk.filter((m) => !THROUGH_0028(m.version)).map((m) => m.version);
    expect(after.length).toBeGreaterThan(0);
    const expected =
      label === 'fresh'
        ? { applied: [...through, ...after], alreadyApplied: [] }
        : { applied: after, alreadyApplied: through };
    expect({
      applied: built.migration.applied,
      alreadyApplied: built.migration.alreadyApplied,
    }).toStrictEqual(expected);
  });

  // Only the upgraded leg has seeded rows, so only it registers the case.
  if (label !== 'fresh') {
    it('keeps every seeded row as it was', () => {
      expect(built.seeded).toMatch(/AUD.*#.*AUD/u);
      expect(built.seededAfter).toBe(built.seeded);
    });
  }

  describe.each(WRITES.map((write) => [write.label, write] as const))('%s', (_label, write) => {
    it.each(SETTINGS)(
      'past the ceiling, with the setting %s before commit, is refused and moves nothing',
      async (_setting, settingOf) => {
        const { capId, envelopeId } = await startingCap(w);
        const before = await capState(w, capId);
        expect(before).toBe('AUD 1000 900');
        await expect(
          writeThenChange(w, write, capId, envelopeId, write.over, settingOf(w)),
        ).rejects.toMatchObject(CEILING);
        expect(await capState(w, capId)).toBe(before);
      },
    );

    it.each(SETTINGS)(
      'within the ceiling, with the setting %s before commit, is refused too: an unreadable ceiling is not room',
      async (_setting, settingOf) => {
        const { capId, envelopeId } = await startingCap(w);
        await expect(
          writeThenChange(w, write, capId, envelopeId, write.within, settingOf(w)),
        ).rejects.toMatchObject(CEILING);
        expect(await capState(w, capId)).toBe('AUD 1000 900');
      },
    );

    it('within the ceiling under a steady setting commits', async () => {
      const { capId, envelopeId } = await startingCap(w);
      await writeThenChange(w, write, capId, envelopeId, write.within, null);
      expect(await capState(w, capId)).toBe(
        write.label === 'the limit lowered' ? 'AUD 900 900' : 'AUD 1000 1000',
      );
    });

    it('past the ceiling under a steady setting is refused, as 0025 already did', async () => {
      const { capId, envelopeId } = await startingCap(w);
      await expect(
        writeThenChange(w, write, capId, envelopeId, write.over, null),
      ).rejects.toMatchObject(CEILING);
      expect(await capState(w, capId)).toBe('AUD 1000 900');
    });
  });
});
