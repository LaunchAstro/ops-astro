// SPDX-License-Identifier: AGPL-3.0-only
//
// I14: the tenant barrier has two halves, and this is the proof that each one
// holds the door on its own.
//
// Every task command reaches its record through one statement -- `lockTask` in
// `packages/core-records/src/commands/prepare.ts`, which selects `from records
// where business_id = $1 and record_type_id = $2 and id = $3 for update`. Two
// independent things stop it returning another business's row: the explicit
// `business_id = $1` predicate the application writes, and the restrictive
// policy `tenancy_records` the migration puts on the table. Both are always on,
// so an ordinary foreign-read test proves only that *at least one* of them
// works. Drop the predicate in a refactor, or leave `enable row level security`
// off a table in a migration, and that test stays green while the installation
// sits one edit away from a cross-tenant read.
//
// So the barrier is taken apart, on a throwaway database, one half at a time:
//
//   (a) both in place       -- the shipped state, and the control.
//   (b) row security off    -- the predicate alone must still deny.
//   (c) predicate removed   -- row security alone must still deny.
//   (d) both removed        -- the row must LEAK, and this file asserts that.
//
// **Why (d) asserts the leak.** A denial is evidence only when the same reach
// would have succeeded had the barrier not been there. Zero rows is the answer
// a query gives for a dozen uninteresting reasons: a mistyped identifier, a
// record never created, a type id from the wrong business, a `for update` on a
// row that is not there. If (d) also returned nothing, (a), (b) and (c) would
// be measuring one of those reasons rather than the barrier, and every
// assertion here would be worth nothing. The leak is the negative control: it
// is what makes the three denials mean what they say. A proof whose negative
// control cannot leak is not a proof, so the leak is asserted as strictly as
// the denials are -- exactly one row, bravo's, with bravo's title in it.
//
// Two further controls sit beside (b) and (c): in each single-half state the
// caller also reaches for their OWN record with the same mutilated statement
// and must get it back, which attributes the zero in (b) to the predicate and
// the zero in (c) to the policy rather than to a statement that had quietly
// stopped finding anything. The authority is real throughout: the caller is an
// enrolled member of alpha holding write and assign over the whole business,
// and both records are made through `executeCommand`.
//
// Everything runs on a `createFreshDatabase` database, created, migrated and
// dropped by this run alone -- `alter table ... disable row level security` is
// a mutation no shared database may see -- and the restore is in a `finally`,
// so a failing expectation cannot leave the barrier down.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  tenancyConformance,
  describeFindings,
  type Finding,
} from '../../packages/core-records/src/tenancy/conformance.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'acceptance/predicate-rls: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The rule in the shipped conformance set that a disabled table has to trip. */
const ROW_SECURITY_RULE = 'row security enabled and forced on every application table';

interface Tenant {
  readonly businessId: string;
  readonly member: Member;
  readonly taskTypeId: string;
}

/** A record to reach for: the two identifiers `lockTask` binds after the tenant. */
type Target = { readonly typeId: string; readonly recordId: string };

/**
 * What one reach actually did, recorded rather than described. `rows` is -1
 * when the server raised, so a refusal is never mistaken for an empty result:
 * they are different denials and the matrix says which.
 */
interface Observation {
  readonly rows: number;
  readonly ids: readonly string[];
  readonly titles: readonly string[];
  readonly sqlstate: string | null;
}

/** The two `pg_class` flags the migration sets and the restore has to put back. */
type RowSecurity = { readonly enabled: boolean; readonly forced: boolean };

interface Matrix {
  readonly bothInPlace: Observation;
  readonly predicateRemoved: Observation;
  readonly ownWithoutPredicate: Observation;
  readonly rlsDisabled: Observation;
  readonly ownWhileDisabled: Observation;
  readonly bothRemoved: Observation;
  readonly restoredBothInPlace: Observation;
  readonly restoredPredicateRemoved: Observation;
  readonly flagsBefore: RowSecurity;
  readonly flagsWhileDisabled: RowSecurity;
  readonly flagsAfter: RowSecurity;
  readonly findingsBefore: readonly Finding[];
  readonly findingsWhileDisabled: readonly Finding[];
  readonly findingsAfter: readonly Finding[];
}

/**
 * `lockTask`'s statement, with and without the half the application writes.
 *
 * Select list, table, `for update` and the remaining conditions are copied
 * from `prepare.ts` unchanged: a statement tidied on the way in is a different
 * statement, and the proof would be about that one instead. The mutilated form
 * renumbers the two survivors because the wire protocol rejects a bind that
 * supplies a parameter the statement never mentions.
 */
function lookupText(predicate: boolean): string {
  return predicate
    ? `select id, revision::text as revision, data, deleted_at, trash_batch_id
         from records
        where business_id = $1 and record_type_id = $2 and id = $3
          for update`
    : `select id, revision::text as revision, data, deleted_at, trash_batch_id
         from records
        where record_type_id = $1 and id = $2
          for update`;
}

/** The SQLSTATE the server gave, or the fault itself when it did not come from one. */
function sqlstateOf(cause: unknown): string {
  const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
  return typeof code === 'string' ? code : String(cause);
}

describe.skipIf(serverUrl === undefined)('I14: the predicate and the policy, one at a time', () => {
  let db: FreshDatabase;
  let alpha: Tenant;
  let bravo: Tenant;
  let alphaTask: Target;
  let bravoTask: Target;
  let matrix: Matrix;

  const enrolTenant = async (key: string): Promise<Tenant> => {
    const businessId = await insertBusiness(db.app, key);
    const spine = await installSpine(db.app, businessId);
    const member = await enrol(db.app, businessId, `${key}-worker`);
    await db.app.withBusiness(businessId, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'assign');
    });
    return { businessId, member, taskTypeId: spine.taskTypeId };
  };

  /** A real record, made the way the product makes one. */
  const createTask = async (tenant: Tenant, title: string): Promise<Target> => {
    const made = await executeCommand(db.app, tenant.businessId, tenant.member.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return { typeId: tenant.taskTypeId, recordId: made.recordId ?? '' };
  };

  /**
   * One reach, inside the tenancy wrapper, with the caller's own business set
   * exactly as `withSession` would have set it. The connection is `db.app`: a
   * member of `ops_astro_app` that owns nothing and carries `nobypassrls`, so
   * a policy that applies to it is one the server enforces rather than one it
   * skips for an owner.
   */
  const reach = async (caller: Tenant, target: Target, pred: boolean): Promise<Observation> => {
    type Row = { readonly id: string; readonly data: Readonly<Record<string, unknown>> };
    // `lockTask` binds `tx.businessId`, which the wrapper sets from exactly
    // this value. Dropping the predicate drops the tenant from the bind too.
    const values = pred
      ? [caller.businessId, target.typeId, target.recordId]
      : [target.typeId, target.recordId];
    try {
      const rows = await db.app.withBusiness(
        caller.businessId,
        async (tx) => await tx.query<Row>(lookupText(pred), values),
      );
      return {
        rows: rows.length,
        ids: rows.map((row) => row.id),
        titles: rows.map((row) => String(row.data['title'] ?? '')),
        sqlstate: null,
      };
    } catch (cause) {
      return { rows: -1, ids: [], titles: [], sqlstate: sqlstateOf(cause) };
    }
  };

  /** Read on the owner connection, where the truth about a relation lives. */
  const rowSecurity = async (): Promise<RowSecurity> => {
    const rows = await db.admin.execute<{
      readonly relrowsecurity: boolean;
      readonly relforcerowsecurity: boolean;
    }>(
      `select c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'records'`,
    );
    return {
      enabled: rows[0]?.relrowsecurity ?? false,
      forced: rows[0]?.relforcerowsecurity ?? false,
    };
  };

  // `tenancyConformance` is the shipped check `prefix-harness.ts` runs after
  // every migration prefix, and it already owns "row security enabled and
  // forced on every application table". Running it here rather than writing a
  // second version means the restoration is judged by the rule the migrations
  // are judged by -- and, while the table is down, that the rule really does
  // notice, which a set that has only ever seen a conforming schema has not
  // been shown to do.
  const runMatrix = async (): Promise<Matrix> => {
    const flagsBefore = await rowSecurity();
    const findingsBefore = await tenancyConformance(db.admin.execute);

    // The shipped state and the states needing row security intact, measured
    // before anything is altered, so (c) is a statement about the database the
    // migrations built rather than one this file put back together.
    const bothInPlace = await reach(alpha, bravoTask, true);
    const predicateRemoved = await reach(alpha, bravoTask, false);
    const ownWithoutPredicate = await reach(alpha, alphaTask, false);

    let flagsWhileDisabled: RowSecurity;
    let findingsWhileDisabled: readonly Finding[];
    let rlsDisabled: Observation;
    let ownWhileDisabled: Observation;
    let bothRemoved: Observation;
    try {
      // The only mutation in this file, as the owner, on a database nothing
      // else can see. `disable` clears `relrowsecurity` and leaves
      // `relforcerowsecurity` alone, which is why the restore is one `enable`
      // and why both flags are asserted after it.
      await db.admin.execute('alter table public.records disable row level security');
      flagsWhileDisabled = await rowSecurity();
      findingsWhileDisabled = await tenancyConformance(db.admin.execute);
      rlsDisabled = await reach(alpha, bravoTask, true);
      ownWhileDisabled = await reach(alpha, alphaTask, true);
      bothRemoved = await reach(alpha, bravoTask, false);
    } finally {
      await db.admin.execute('alter table public.records enable row level security');
    }

    const flagsAfter = await rowSecurity();
    const findingsAfter = await tenancyConformance(db.admin.execute);
    const restoredBothInPlace = await reach(alpha, bravoTask, true);
    const restoredPredicateRemoved = await reach(alpha, bravoTask, false);

    return {
      bothInPlace,
      predicateRemoved,
      ownWithoutPredicate,
      rlsDisabled,
      ownWhileDisabled,
      bothRemoved,
      restoredBothInPlace,
      restoredPredicateRemoved,
      flagsBefore,
      flagsWhileDisabled,
      flagsAfter,
      findingsBefore,
      findingsWhileDisabled,
      findingsAfter,
    };
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'i' });
    alpha = await enrolTenant('alpha');
    bravo = await enrolTenant('bravo');
    alphaTask = await createTask(alpha, 'alpha can see this');
    bravoTask = await createTask(bravo, 'bravo private plan');
    matrix = await runMatrix();
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('the caller is really authorised, and both records really exist', () => {
    it('made two records in two businesses through the command path', () => {
      expect(alphaTask.recordId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(bravoTask.recordId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(alpha.businessId).not.toBe(bravo.businessId);
    });

    it('reads its own record through the same statement, with both halves up', async () => {
      const own = await reach(alpha, alphaTask, true);
      expect({ rows: own.rows, titles: own.titles }).toStrictEqual({
        rows: 1,
        titles: ['alpha can see this'],
      });
    });
  });

  describe('(a) both in place: the shipped state', () => {
    it('returns nothing for the foreign record, and raises nothing', () => {
      // No error is the right shape: the barrier on a read is a filter, not a
      // refusal. The row is not there to be seen, which leaks not even the
      // fact that something was hidden.
      expect(matrix.bothInPlace).toStrictEqual({ rows: 0, ids: [], titles: [], sqlstate: null });
    });
  });

  describe('(b) row-level security disabled: the predicate alone', () => {
    // That the policy really came off is `flagsWhileDisabled`, asserted below.
    it('still finds its own record, so the statement had not stopped working', () => {
      expect({
        rows: matrix.ownWhileDisabled.rows,
        titles: matrix.ownWhileDisabled.titles,
      }).toStrictEqual({ rows: 1, titles: ['alpha can see this'] });
    });

    it('returns nothing for the foreign record: the predicate held the door alone', () => {
      expect(matrix.rlsDisabled).toStrictEqual({ rows: 0, ids: [], titles: [], sqlstate: null });
    });
  });

  describe('(c) the predicate removed: the policy alone', () => {
    it('still finds its own record without the predicate, so the policy is what filters', () => {
      expect({
        rows: matrix.ownWithoutPredicate.rows,
        titles: matrix.ownWithoutPredicate.titles,
      }).toStrictEqual({ rows: 1, titles: ['alpha can see this'] });
    });

    it('returns nothing for the foreign record: row security held the door alone', () => {
      expect(matrix.predicateRemoved).toStrictEqual({
        rows: 0,
        ids: [],
        titles: [],
        sqlstate: null,
      });
    });
  });

  // The most important case in the file. See the header: without it, the three
  // denials above are consistent with a statement that could never have
  // returned anything, and the barrier would be unproved.
  describe('(d) both removed: the leak, asserted', () => {
    it('hands business alpha business bravo record, in full', () => {
      expect(matrix.bothRemoved.sqlstate).toBeNull();
      expect(matrix.bothRemoved.rows).toBe(1);
      expect(matrix.bothRemoved.ids).toStrictEqual([bravoTask.recordId]);
      expect(matrix.bothRemoved.titles).toStrictEqual(['bravo private plan']);
    });

    it('is the reach (a), (b) and (c) refused, so they refused something reachable', () => {
      // One statement, one caller, one target; the only difference between this
      // row of the matrix and the other three is which half of the barrier was
      // standing. That is what makes the other three evidence.
      expect(matrix.bothInPlace.rows).toBe(0);
      expect(matrix.rlsDisabled.rows).toBe(0);
      expect(matrix.predicateRemoved.rows).toBe(0);
      expect(matrix.bothRemoved.rows).toBe(1);
    });
  });

  describe('the barrier is back up, and the catalogue says so', () => {
    it('had both flags set before the mutation, and has both set after it', () => {
      expect(matrix.flagsBefore).toStrictEqual({ enabled: true, forced: true });
      expect(matrix.flagsWhileDisabled).toStrictEqual({ enabled: false, forced: true });
      expect(matrix.flagsAfter).toStrictEqual({ enabled: true, forced: true });
    });

    it('denies the foreign read again, in both of the states that denied it before', () => {
      expect(matrix.restoredBothInPlace).toStrictEqual(matrix.bothInPlace);
      expect(matrix.restoredPredicateRemoved).toStrictEqual(matrix.predicateRemoved);
    });

    it('leaves a database the conformance set finds nothing wrong with', () => {
      expect(describeFindings(matrix.findingsBefore)).toBe('');
      expect(describeFindings(matrix.findingsAfter)).toBe('');
    });

    it('was noticed by that same conformance set while it was down', () => {
      // If the set could not see the disabled table, "clean afterwards" would
      // be a sentence about a check that never looks.
      const noticed = matrix.findingsWhileDisabled.filter(
        (finding) => finding.rule === ROW_SECURITY_RULE && finding.object === 'records',
      );
      expect(noticed).toHaveLength(1);
      expect(noticed[0]?.detail).toBe('enabled false, forced true');
    });
  });
});
