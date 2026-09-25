// SPDX-License-Identifier: AGPL-3.0-only
//
// I14 on the lookup the product runs: the barrier proof as a mutation detector.
//
// `lockTask` in `commands/prepare.ts` is the one read every targeted command
// shares. Two things stop it returning another business's row: the tenant
// predicate it writes and the forced policy `tenancy_records`. The proof below
// (`prove`) checks each half alone, the catalogue, and the shipped read. It is
// then run five times, once per state of the barrier, and each run has to turn
// red at exactly the check that exercises the half that was taken away:
//
//   intact            -- the proof passes.
//   predicate removed -- the production source is copied and the copy's
//                        statement loses `business_id = $1`
//                        (`tests/support/source-mutant.ts`), and the proof
//                        goes red at "predicate alone" and nowhere else.
//   RLS disabled      -- `alter table ... disable row level security`, and the
//                        proof goes red at the catalogue and "policy alone".
//   both removed      -- every check is red, and the shipped read leaks.
//
// No SQL is copied out of the product. Every read is `lockTask` itself: the
// shipped module where the predicate stands, and where it is removed the same
// module loaded from a disposable copy of the package source in which the one
// constant line is replaced, with the statement, its binds, its callers and the
// command path around it the shipped code. The shipped module has no setter,
// so nothing in the running product can change its tenant filter.
// `acceptance/predicate-rls.test.ts` keeps its copied statement as
// supplementary evidence only.
//
// The command path is run in every state too, with real authority: alpha's
// worker holds write over the whole business, so the grant check passes for
// bravo's identifier and the refusal that comes back is the one `prepareCommand`
// gives only after `lockTask` has returned nothing. The caller sees `NOT_FOUND`
// and alpha's audit records `NOT_FOUND`. `WRONG_BUSINESS` is registered and
// unproducible by the accepted contract (4.4, corrected 14 September 2026), so
// it is asserted absent rather than present.
//
// A third barrier shows up here that the copied statement hid. `lockTask`
// binds the caller's own task type, `record_types.id` is globally unique and
// `records` carries a composite key onto it, so through the command path a
// foreign row is out of reach even with both halves gone. That is recorded,
// not relied on: the proof reaches bravo's row with bravo's type on purpose.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { tenancyConformance } from '../../packages/core-records/src/tenancy/conformance.ts';
import * as shippedEnvelope from '../../packages/core-records/src/commands/envelope.ts';
import * as shippedRefusal from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import * as shippedPrepare from '../../packages/core-records/src/commands/prepare.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { createSourceMutant, type SourceMutant } from '../support/source-mutant.ts';

const serverUrl = databaseUrlFromEnvironment();

const ROW_SECURITY_RULE = 'row security enabled and forced on every application table';

/** The one line the mutant changes: a condition that binds `$1` and filters nothing. */
const PREDICATE_MUTATION = {
  file: 'packages/core-records/src/commands/prepare.ts',
  from: "const TENANT_PREDICATE = 'business_id = $1';",
  to: "const TENANT_PREDICATE = '$1::uuid is not null';",
};

/** The modules one run reads and commands through: the shipped ones, or the mutant's. */
interface Code {
  readonly lockTask: typeof shippedPrepare.lockTask;
  readonly executeCommand: typeof shippedEnvelope.executeCommand;
  readonly isCommandRefusal: typeof shippedRefusal.isCommandRefusal;
}

const SHIPPED: Code = {
  lockTask: shippedPrepare.lockTask,
  executeCommand: shippedEnvelope.executeCommand,
  isCommandRefusal: shippedRefusal.isCommandRefusal,
};

interface Tenant {
  readonly businessId: string;
  readonly member: Member;
  readonly taskTypeId: string;
}

type Target = { readonly typeId: string; readonly recordId: string };

type Check = 'catalogue' | 'predicate alone' | 'policy alone' | 'shipped read';

/** One run of the proof: which checks went red, and what the red ones saw. */
interface Verdict {
  readonly red: readonly Check[];
  readonly leaked: Readonly<Partial<Record<Check, readonly string[]>>>;
}

/** What the command path told the caller and wrote to the caller's own audit. */
interface CommandRun {
  readonly callerCode: string | null;
  readonly auditCodes: readonly (string | null)[];
  readonly bravoTitle: string;
  readonly ownApplied: boolean;
}

type State = 'intact' | 'predicate removed' | 'RLS disabled' | 'both removed';

describe.skipIf(serverUrl === undefined)('I14: the production lookup under mutation', () => {
  let db: FreshDatabase;
  let alpha: Tenant;
  let bravo: Tenant;
  let alphaTask: Target;
  let bravoTask: Target;
  let mutant: SourceMutant;
  /** The same modules, loaded from the copy whose tenant predicate is gone. */
  let removed: Code;
  const verdicts = new Map<State, Verdict>();
  const commands = new Map<State, CommandRun>();

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

  const createTask = async (tenant: Tenant, title: string): Promise<Target> => {
    const made = await SHIPPED.executeCommand(
      db.app,
      tenant.businessId,
      tenant.member.presented,
      'api',
      {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title },
      } as Parameters<Code['executeCommand']>[4],
    );
    if (SHIPPED.isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return { typeId: tenant.taskTypeId, recordId: made.recordId ?? '' };
  };

  /** The production `lockTask`, shipped or mutant, inside the caller's own tenancy wrapper. */
  const lookup = async (caller: Tenant, target: Target, code: Code = SHIPPED) =>
    await db.app.withBusiness(
      caller.businessId,
      async (tx) => await code.lockTask(tx, target.typeId, target.recordId),
    );

  const titlesOf = async (
    caller: Tenant,
    target: Target,
    code: Code = SHIPPED,
  ): Promise<readonly string[]> => {
    const row = await lookup(caller, target, code);
    return row === undefined ? [] : [String(row.data['title'] ?? '')];
  };

  const rlsEnabled = async (): Promise<boolean> => {
    const rows = await db.admin.execute<{ readonly relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.records'::regclass`,
    );
    return rows[0]?.relrowsecurity ?? false;
  };

  const setRls = async (on: boolean): Promise<void> => {
    await db.admin.execute(
      `alter table public.records ${on ? 'enable' : 'disable'} row level security`,
    );
  };

  /** Run `body` with row security off, and put back whatever state it found. */
  const withoutRls = async <T>(body: () => Promise<T>): Promise<T> => {
    const was = await rlsEnabled();
    if (was) await setRls(false);
    try {
      return await body();
    } finally {
      if (was) await setRls(true);
    }
  };

  /**
   * The barrier proof. Each check that reaches for bravo's record also reaches
   * for alpha's own through the same state, and throws if that comes back
   * empty: a zero is evidence only while the statement can still find a row.
   * `code` is the lookup this state runs; "policy alone" always reads through
   * the mutant, because that check is the predicate taken away.
   */
  const prove = async (code: Code): Promise<Verdict> => {
    const red: Check[] = [];
    const leaked: Partial<Record<Check, readonly string[]>> = {};
    const reach = async (check: Check, through: Code): Promise<void> => {
      if ((await titlesOf(alpha, alphaTask, through)).length !== 1) {
        throw new Error(`${check}: the lookup no longer finds the caller's own record`);
      }
      const foreign = await titlesOf(alpha, bravoTask, through);
      if (foreign.length > 0) {
        red.push(check);
        leaked[check] = foreign;
      }
    };
    const findings = await tenancyConformance(db.admin.execute);
    if (findings.some((f) => f.rule === ROW_SECURITY_RULE && f.object === 'records')) {
      red.push('catalogue');
    }
    await withoutRls(async () => await reach('predicate alone', code));
    await reach('policy alone', removed);
    await reach('shipped read', code);
    return { red, leaked };
  };

  /** alpha names bravo's record through the real command path, then its own. */
  const runCommands = async (code: Code): Promise<CommandRun> => {
    const before = (await readAudit(alpha)).length;
    const bravoRow = await lookup(bravo, bravoTask);
    const probe = await code.executeCommand(
      db.app,
      alpha.businessId,
      alpha.member.presented,
      'api',
      {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: bravoTask.recordId,
        expectedRevision: bravoRow?.revision ?? 1,
        fields: { title: 'alpha was here' },
      } as Parameters<Code['executeCommand']>[4],
    );
    const ownRow = await lookup(alpha, alphaTask);
    const own = await code.executeCommand(db.app, alpha.businessId, alpha.member.presented, 'api', {
      command: 'task.update',
      operationId: randomUUID(),
      recordId: alphaTask.recordId,
      expectedRevision: ownRow?.revision ?? 1,
      fields: { title: 'alpha can see this' },
    } as Parameters<Code['executeCommand']>[4]);
    const events = (await readAudit(alpha)).slice(before);
    return {
      callerCode: code.isCommandRefusal(probe) ? probe.code : null,
      auditCodes: events.map((event) => event.refusal_code),
      bravoTitle: (await titlesOf(bravo, bravoTask))[0] ?? '',
      ownApplied: !code.isCommandRefusal(own),
    };
  };

  const readAudit = async (tenant: Tenant) =>
    await db.app.withBusiness(tenant.businessId, readAuditEvents);

  /** Put the barrier into one state, run the proof and the command path, take it back out. */
  const underState = async (state: State): Promise<void> => {
    const predicate = state === 'predicate removed' || state === 'both removed';
    const rls = state === 'RLS disabled' || state === 'both removed';
    const code = predicate ? removed : SHIPPED;
    try {
      if (rls) await setRls(false);
      verdicts.set(state, await prove(code));
      commands.set(state, await runCommands(code));
    } finally {
      if (rls) await setRls(true);
    }
  };

  beforeAll(async () => {
    mutant = createSourceMutant(PREDICATE_MUTATION);
    removed = {
      lockTask: (await mutant.load<typeof shippedPrepare>(PREDICATE_MUTATION.file)).lockTask,
      executeCommand: (
        await mutant.load<typeof shippedEnvelope>('packages/core-records/src/commands/envelope.ts')
      ).executeCommand,
      isCommandRefusal: (
        await mutant.load<typeof shippedRefusal>('packages/core-records/src/commands/refusal.ts')
      ).isCommandRefusal,
    };
    db = await createFreshDatabase({ part: 'i' });
    alpha = await enrolTenant('alpha');
    bravo = await enrolTenant('bravo');
    alphaTask = await createTask(alpha, 'alpha can see this');
    bravoTask = await createTask(bravo, 'bravo private plan');
    // One after another, never together: every state mutates the one database.
    await underState('intact');
    await underState('predicate removed');
    await underState('RLS disabled');
    await underState('both removed');
  }, 240_000);

  afterAll(async () => {
    await db?.drop();
    mutant?.dispose();
  });

  describe('the four runs of the proof, each red for its own reason', () => {
    it('intact: the proof passes', () => {
      expect(verdicts.get('intact')).toStrictEqual({ red: [], leaked: {} });
    });

    it('predicate removed from the production statement: red at "predicate alone" only', () => {
      expect(verdicts.get('predicate removed')).toStrictEqual({
        red: ['predicate alone'],
        leaked: { 'predicate alone': ['bravo private plan'] },
      });
    });

    it('RLS disabled in the catalogue: red at the catalogue and at "policy alone"', () => {
      expect(verdicts.get('RLS disabled')).toStrictEqual({
        red: ['catalogue', 'policy alone'],
        leaked: { 'policy alone': ['bravo private plan'] },
      });
    });

    it("both removed: every check red, and the shipped read hands over bravo's row", () => {
      expect(verdicts.get('both removed')).toStrictEqual({
        red: ['catalogue', 'predicate alone', 'policy alone', 'shipped read'],
        leaked: {
          'predicate alone': ['bravo private plan'],
          'policy alone': ['bravo private plan'],
          'shipped read': ['bravo private plan'],
        },
      });
    });

    it('ran a mutant that is a separate module, not the shipped one', () => {
      expect(removed.lockTask).not.toBe(SHIPPED.lockTask);
      expect(removed.executeCommand).not.toBe(SHIPPED.executeCommand);
    });

    it('left the shipped module without a setter and forced row security behind it', async () => {
      expect(Object.keys(shippedPrepare).filter((name) => /predicate/iu.test(name))).toStrictEqual(
        [],
      );
      expect(await rlsEnabled()).toBe(true);
      expect(await prove(SHIPPED)).toStrictEqual({ red: [], leaked: {} });
    });
  });

  describe('the command path, with real authority, in every state', () => {
    const states: readonly State[] = [
      'intact',
      'predicate removed',
      'RLS disabled',
      'both removed',
    ];

    it.each(states)('%s: the grant passes and the read is reached', (state) => {
      // The same worker, the same command, alpha's own record: applied. So the
      // refusal below is not an authority refusal, and `prepareCommand` gives
      // `NOT_FOUND` only after `lockTask` has returned nothing.
      expect(commands.get(state)?.ownApplied).toBe(true);
    });

    it.each(states)('%s: the caller sees NOT_FOUND and bravo is untouched', (state) => {
      expect(commands.get(state)?.callerCode).toBe('NOT_FOUND');
      expect(commands.get(state)?.bravoTitle).toBe('bravo private plan');
    });

    it.each(states)("%s: alpha's audit records NOT_FOUND, never WRONG_BUSINESS", (state) => {
      // Contract 4.4 as corrected: the code stays registered and unproducible,
      // and the probe's trail lands in the prober's own business.
      expect(commands.get(state)?.auditCodes).toStrictEqual(['NOT_FOUND', null]);
    });
  });
});
