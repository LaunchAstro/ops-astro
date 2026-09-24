// SPDX-License-Identifier: AGPL-3.0-only
//
// The storage backstop behind the cap: migrations 0024 and 0025.
//
// Sol 6 RUNTIME P2 at 056aa7c: `task_envelopes` named its cap by business and
// id only, so the application role could insert a USD envelope under an AUD
// cap, or change a cap's currency beneath envelopes that already draw on it.
// The command refuses both (`CAP_BINDING_MISMATCH`, `budget.ts`), but a stored
// relationship the command cannot reach is not held by the command. Nathan
// approved two storage rules (SOL-RUNTIME-FIX handback, "Proposed protected
// migration"):
//
//   1. 0024: an envelope's currency is its cap's. `(business_id, cap_id,
//      currency)` references the cap's `(business_id, id, currency)`.
//   2. 0025: the committed total under a cap, `sum(held_minor + actual_minor)` over
//      every envelope that draws on it, never exceeds `limit_minor` at commit,
//      whatever path writes the envelopes or the cap.
//
// Every write below is the application role's, inside `withBusiness`, never
// the owner's. The same cases run on a database migrated from empty and on
// one migrated to 0023, seeded, and then upgraded: fresh and upgraded behave
// the same. The seeded rows survive the upgrade byte for byte, and a 0023
// database already holding a row a new rule forbids stops before the
// migration that states the rule, rather than keeping the row silently.

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
import {
  connect,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/cap-storage-backstop: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const LIMIT = 1000;
const THROUGH_0023 = (version: string): boolean => version.slice(0, 4) <= '0023';
/** The two this suite is about. Later migrations may follow them on disk. */
const NEW = ['0024', '0025'];

interface World {
  readonly db: EmptyDatabase;
  readonly business: BusinessId;
  readonly decider: Member;
  /** The fixture's synthetic AUD cap, limit 1000. */
  readonly capId: string;
}

async function openWorld(db: EmptyDatabase, key: string): Promise<World> {
  const business = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, business);
  const decider = await enrol(db.app, business, 'decider');
  const capId = randomUUID();
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action);
    }
    await insertCap(tx, business, capId, 'AUD', LIMIT);
  });
  return { db, business, decider, capId };
}

async function insertCap(
  tx: TenantQuery,
  business: string,
  capId: string,
  currency: string,
  limit: number | string,
): Promise<void> {
  await tx.query(
    `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
     values ($1, $2, $3, $4::text::bigint, $5)`,
    [business, capId, `cap-${capId}`, String(limit), currency],
  );
}

async function createTask(w: World): Promise<string> {
  const outcome = await executeCommand(w.db.app, w.business, w.decider.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: `backstop ${randomUUID()}` },
  } as never);
  if (isCommandRefusal(outcome) || outcome.recordId === null) {
    throw new Error('task.create did not apply');
  }
  return outcome.recordId;
}

/** As the application role: one statement in its own tenant transaction. */
async function asApp(w: World, text: string, parameters: readonly unknown[]): Promise<void> {
  await w.db.app.withBusiness(w.business, async (tx) => {
    await tx.query(text, [...parameters]);
  });
}

/** A new envelope on a fresh task, as the application role. Returns its id. */
async function envelope(
  w: World,
  options: {
    readonly capId?: string;
    readonly currency?: string;
    readonly heldMinor?: number;
    readonly maximumMinor?: number;
  } = {},
): Promise<string> {
  const taskId = await createTask(w);
  const id = randomUUID();
  await asApp(
    w,
    `insert into public.task_envelopes
       (business_id, id, cap_id, task_id, maximum_minor, held_minor, currency)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      w.business,
      id,
      options.capId ?? w.capId,
      taskId,
      options.maximumMinor ?? LIMIT * 4,
      options.heldMinor ?? 0,
      options.currency ?? 'AUD',
    ],
  );
  return id;
}

async function addHeld(w: World, envelopeId: string, by: number): Promise<void> {
  await asApp(
    w,
    `update public.task_envelopes set held_minor = held_minor + $3
      where business_id = $1 and id = $2`,
    [w.business, envelopeId, by],
  );
}

/** The cap's committed total and its currency, read by the owner as text. */
async function capState(w: World, capId: string = w.capId): Promise<string> {
  const [row] = await w.db.admin.execute<{ readonly state: string }>(
    `select c.currency || ' ' || c.limit_minor::text || ' ' ||
            coalesce((select sum(e.held_minor + e.actual_minor) from public.task_envelopes e
                       where e.business_id = c.business_id and e.cap_id = c.id), 0)::text as state
       from public.budget_caps c where c.business_id = $1 and c.id = $2`,
    [w.business, capId],
  );
  return row?.state ?? 'absent';
}

/** A promise the test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const CURRENCY_BINDING = { code: '23503', constraint_name: 'task_envelopes_cap_currency_fkey' };
const CEILING = { code: '23514', constraint_name: 'budget_caps_ceiling' };
const SERIALIZATION = { code: '40001' };

interface Built {
  readonly db: EmptyDatabase;
  readonly migration: MigrationOutcome;
  readonly seeded?: string;
  readonly seededAfter?: string;
}

const onDisk = readMigrations('migrations');

async function fresh(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'capfresh' });
  return { db, migration: await applyMigrations(db.admin, onDisk) };
}

/** Everything the 0023 seed wrote, as the owner reads it, in one string. */
async function seedSnapshot(db: EmptyDatabase): Promise<string> {
  const [row] = await db.admin.execute<{ readonly all: string | null }>(
    `select (select string_agg(c::text, '|' order by c.id) from public.budget_caps c) || '#' ||
            (select string_agg(e::text, '|' order by e.id) from public.task_envelopes e) as all`,
  );
  return row?.all ?? '';
}

async function upgraded(): Promise<Built> {
  const db = await createEmptyDatabase({ part: 'capupgraded' });
  await applyMigrations(
    db.admin,
    onDisk.filter((m) => THROUGH_0023(m.version)),
  );
  // Valid rows written through the application role at 0023: an AUD cap filled
  // to its ceiling across two envelopes, and a USD cap with one envelope.
  const w = await openWorld(db, 'seed-0023');
  const usd = randomUUID();
  await w.db.app.withBusiness(w.business, async (tx) => {
    await insertCap(tx, w.business, usd, 'USD', 50);
  });
  await envelope(w, { heldMinor: 400 });
  await envelope(w, { heldMinor: 600 });
  await envelope(w, { capId: usd, currency: 'USD', heldMinor: 50 });
  const seeded = await seedSnapshot(db);
  // The runner refuses while this database has other sessions; seeding opened one.
  await db.closeSessions();
  const migration = await migrate(db.admin, 'migrations');
  return { db, migration, seeded, seededAfter: await seedSnapshot(db) };
}

describe.skipIf(serverUrl === undefined).each([
  ['fresh', fresh],
  ['upgraded from 0023', upgraded],
] as const)('cap storage backstop on a %s database', (label, build) => {
  let built: Built;
  let w: World;

  beforeAll(async () => {
    built = await build();
    w = await openWorld(built.db, `backstop-${label.replaceAll(' ', '-')}`);
  }, 120_000);

  afterAll(async () => {
    await built?.db.drop();
  });

  it('applies 0024 and 0025 after 0023, and every migration once', () => {
    const through = onDisk.filter((m) => THROUGH_0023(m.version)).map((m) => m.version);
    const after = onDisk.filter((m) => !THROUGH_0023(m.version)).map((m) => m.version);
    expect(after.slice(0, 2).map((v) => v.slice(0, 4))).toStrictEqual(NEW);
    const expected =
      label === 'fresh'
        ? { applied: [...through, ...after], alreadyApplied: [] }
        : { applied: after, alreadyApplied: through };
    expect({
      applied: built.migration.applied,
      alreadyApplied: built.migration.alreadyApplied,
    }).toStrictEqual(expected);
  });

  // Only the upgraded leg has seeded rows, so only it registers the case; a
  // skipped or empty case would prove nothing on the fresh leg.
  if (label !== 'fresh') {
    it('keeps every seeded row as it was', () => {
      expect(built.seeded).toMatch(/AUD.*#/u);
      expect(built.seededAfter).toBe(built.seeded);
    });
  }

  describe('an envelope is in its cap currency', () => {
    it('refuses a USD envelope under the AUD cap', async () => {
      const before = await capState(w);
      await expect(envelope(w, { currency: 'USD', heldMinor: 1 })).rejects.toMatchObject(
        CURRENCY_BINDING,
      );
      expect(await capState(w)).toBe(before);
    });

    it('refuses a cap currency change beneath an envelope, and allows it on a cap nobody draws on', async () => {
      const drawn = randomUUID();
      const idle = randomUUID();
      await w.db.app.withBusiness(w.business, async (tx) => {
        await insertCap(tx, w.business, drawn, 'AUD', LIMIT);
        await insertCap(tx, w.business, idle, 'AUD', LIMIT);
      });
      await envelope(w, { capId: drawn });
      await expect(
        asApp(
          w,
          `update public.budget_caps set currency = 'USD' where business_id = $1 and id = $2`,
          [w.business, drawn],
        ),
      ).rejects.toMatchObject(CURRENCY_BINDING);
      expect(await capState(w, drawn)).toBe('AUD 1000 0');
      await asApp(
        w,
        `update public.budget_caps set currency = 'USD' where business_id = $1 and id = $2`,
        [w.business, idle],
      );
      expect(await capState(w, idle)).toBe('USD 1000 0');
    });

    it('refuses moving an envelope to another currency or to a cap in another currency', async () => {
      const usd = randomUUID();
      await w.db.app.withBusiness(w.business, async (tx) => {
        await insertCap(tx, w.business, usd, 'USD', LIMIT);
      });
      const id = await envelope(w);
      await expect(
        asApp(
          w,
          `update public.task_envelopes set currency = 'USD' where business_id = $1 and id = $2`,
          [w.business, id],
        ),
      ).rejects.toMatchObject(CURRENCY_BINDING);
      await expect(
        asApp(
          w,
          `update public.task_envelopes set cap_id = $3 where business_id = $1 and id = $2`,
          [w.business, id, usd],
        ),
      ).rejects.toMatchObject(CURRENCY_BINDING);
      expect(await capState(w, usd)).toBe('USD 1000 0');
    });
  });

  describe('the committed total under a cap never exceeds its ceiling at commit', () => {
    /** Each case gets its own AUD cap of 1000, so the cases do not share a total. */
    async function ownCap(): Promise<World> {
      const capId = randomUUID();
      await w.db.app.withBusiness(w.business, async (tx) => {
        await insertCap(tx, w.business, capId, 'AUD', LIMIT);
      });
      return { ...w, capId };
    }

    it('fills to exactly the ceiling and refuses one unit more, on hold and on actual', async () => {
      const cap = await ownCap();
      const a = await envelope(cap, { heldMinor: 600 });
      const b = await envelope(cap, { heldMinor: 400 });
      expect(await capState(cap)).toBe('AUD 1000 1000');
      await expect(addHeld(cap, a, 1)).rejects.toMatchObject(CEILING);
      await expect(
        asApp(
          cap,
          `update public.task_envelopes set actual_minor = 1 where business_id = $1 and id = $2`,
          [cap.business, b],
        ),
      ).rejects.toMatchObject(CEILING);
      await expect(envelope(cap, { heldMinor: 1 })).rejects.toMatchObject(CEILING);
      expect(await capState(cap)).toBe('AUD 1000 1000');
    });

    it('refuses one insert that alone holds more than the cap', async () => {
      const cap = await ownCap();
      await expect(envelope(cap, { heldMinor: LIMIT + 1 })).rejects.toMatchObject(CEILING);
      expect(await capState(cap)).toBe('AUD 1000 0');
    });

    it('judges at commit: a total past the ceiling inside the transaction and back under it commits', async () => {
      const cap = await ownCap();
      const a = await envelope(cap, { heldMinor: 900 });
      await cap.db.app.withBusiness(cap.business, async (tx) => {
        await tx.query(
          `update public.task_envelopes set held_minor = held_minor + 500 where business_id = $1 and id = $2`,
          [cap.business, a],
        );
        await tx.query(
          `update public.task_envelopes set held_minor = held_minor - 500 where business_id = $1 and id = $2`,
          [cap.business, a],
        );
      });
      expect(await capState(cap)).toBe('AUD 1000 900');
    });

    it('refuses lowering the limit under the committed total, and allows lowering it to the total', async () => {
      const cap = await ownCap();
      await envelope(cap, { heldMinor: 700 });
      const lower = (to: number): Promise<void> =>
        asApp(
          cap,
          `update public.budget_caps set limit_minor = $3 where business_id = $1 and id = $2`,
          [cap.business, cap.capId, to],
        );
      await expect(lower(699)).rejects.toMatchObject(CEILING);
      expect(await capState(cap)).toBe('AUD 1000 700');
      await lower(700);
      expect(await capState(cap)).toBe('AUD 700 700');
    });

    it('refuses the second of two open transactions that each fit alone, neither taking the cap lock', async () => {
      const cap = await ownCap();
      const a = await envelope(cap);
      const b = await envelope(cap);
      const first = connect(cap.db.appUrl, { source: 'racer' });
      const second = connect(cap.db.appUrl, { source: 'racer' });
      try {
        const gateA = barrier();
        const gateB = barrier();
        const wrote = { a: barrier(), b: barrier() };
        const txA = first.withBusiness(cap.business, async (tx) => {
          await tx.query(
            `update public.task_envelopes set held_minor = 600 where business_id = $1 and id = $2`,
            [cap.business, a],
          );
          wrote.a.release();
          await gateA.held;
        });
        const txB = second.withBusiness(cap.business, async (tx) => {
          await tx.query(
            `update public.task_envelopes set held_minor = 500 where business_id = $1 and id = $2`,
            [cap.business, b],
          );
          wrote.b.release();
          await gateB.held;
        });
        // Both writes are in, both uncommitted, and each fits the cap alone.
        await Promise.all([wrote.a.held, wrote.b.held]);
        gateA.release();
        await txA;
        gateB.release();
        await expect(txB).rejects.toMatchObject(CEILING);
      } finally {
        await first.close();
        await second.close();
      }
      expect(await capState(cap)).toBe('AUD 1000 600');
    });

    // Sol 6 SURFACE-R-2 at e84add2: a row lock does not refresh a repeatable
    // read snapshot, so a second transaction that waited for the cap lock
    // summed from before the first committed, and both committed past the
    // ceiling. The trigger now claims the cap with a real row version, so a
    // stale snapshot cannot claim it: read committed re-sums and is refused
    // `budget_caps_ceiling`; repeatable read and serializable are refused
    // `serialization_failure` (40001), which a caller retries in a fresh
    // snapshot that sees the first commit.
    it.each([
      ['read committed', CEILING],
      ['repeatable read', SERIALIZATION],
      ['serializable', SERIALIZATION],
    ] as const)(
      'refuses the second of two %s transactions whose snapshots both saw room',
      async (level, refusal) => {
        const cap = await ownCap();
        const a = await envelope(cap);
        const b = await envelope(cap);
        const url = new URL(cap.db.appUrl);
        url.searchParams.set('default_transaction_isolation', level);
        const first = connect(url.toString(), { source: 'racer' });
        const second = connect(url.toString(), { source: 'racer' });
        try {
          const snapped = { a: barrier(), b: barrier() };
          const gateA = barrier();
          const gateB = barrier();
          const wrote = barrier();
          let seenB = '';
          const raise = async (
            tx: TenantQuery,
            id: string,
            to: number,
            mine: { readonly release: () => void },
          ): Promise<string> => {
            // The first statement takes the snapshot: the cap is empty in both.
            const [row] = await tx.query<{ readonly level: string; readonly total: string }>(
              `select current_setting('transaction_isolation') as level,
                      coalesce(sum(held_minor + actual_minor), 0)::text as total
                 from public.task_envelopes where business_id = $1 and cap_id = $2`,
              [cap.business, cap.capId],
            );
            mine.release();
            await tx.query(
              `update public.task_envelopes set held_minor = $3 where business_id = $1 and id = $2`,
              [cap.business, id, to],
            );
            return `${row?.level} ${row?.total}`;
          };
          const txA = first.withBusiness(cap.business, async (tx) => {
            const seen = await raise(tx, a, 600, snapped.a);
            await snapped.b.held;
            await gateA.held;
            return seen;
          });
          const txB = second.withBusiness(cap.business, async (tx) => {
            await snapped.a.held;
            seenB = await raise(tx, b, 500, snapped.b);
            wrote.release();
            await gateB.held;
            return seenB;
          });
          // Both snapshots are taken before either commits, both saw an empty
          // cap, and each raise fits the cap alone.
          await wrote.held;
          expect(seenB).toBe(`${level} 0`);
          gateA.release();
          expect(await txA).toBe(`${level} 0`);
          gateB.release();
          await expect(txB).rejects.toMatchObject(refusal);
        } finally {
          await first.close();
          await second.close();
        }
        expect(await capState(cap)).toBe('AUD 1000 600');
      },
    );
  });
});

describe.skipIf(serverUrl === undefined)('a 0023 database holding a row a new rule forbids', () => {
  it.each([
    // The run is one transaction, so the ledger stays at 0023 whichever file
    // refuses; the file the runner names is what says the rule's own
    // migration refused. 0031 repeats 0025's check with the same message.
    [
      'a USD envelope under an AUD cap',
      'AUD',
      1000,
      'USD',
      10,
      /currency/u,
      '0024_cap_envelope_currency_binding',
    ],
    [
      'an AUD cap committed past its limit',
      'AUD',
      100,
      'AUD',
      101,
      /ceiling/u,
      '0025_cap_ceiling_at_commit',
    ],
  ] as const)(
    'refuses the upgrade for %s, stopping before the rule with the row untouched',
    async (_label, capCurrency, limit, envelopeCurrency, held, message, refusedBy) => {
      const db = await createEmptyDatabase({ part: 'caprefused' });
      try {
        await applyMigrations(
          db.admin,
          onDisk.filter((m) => THROUGH_0023(m.version)),
        );
        const w = await openWorld(db, 'refused-0023');
        const capId = randomUUID();
        await w.db.app.withBusiness(w.business, async (tx) => {
          await insertCap(tx, w.business, capId, capCurrency, limit);
        });
        // At 0023 nothing in storage stops either row; only the command did.
        await envelope({ ...w, capId }, { currency: envelopeCurrency, heldMinor: held });
        const seeded = await seedSnapshot(db);
        // The runner refuses while this database has other sessions; seeding opened one.
        await db.closeSessions();
        const refused = await migrate(db.admin, 'migrations').catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toMatch(
          new RegExp(`^migrate: ${refusedBy} failed on:`, 'u'),
        );
        expect(String((refused as { cause?: unknown }).cause ?? refused)).toMatch(message);
        const [ledger] = await db.admin.execute<{ readonly last: string }>(
          `select max(version) as last from ops.schema_migrations`,
        );
        expect(ledger?.last.slice(0, 4)).toBe('0023');
        expect(await seedSnapshot(db)).toBe(seeded);
      } finally {
        await db.drop();
      }
    },
    120_000,
  );
});
