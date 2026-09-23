// SPDX-License-Identifier: AGPL-3.0-only
//
// T04 and T05 as named negative mutations of the tenancy wrapper, with the
// restored run beside them (LEDGER:49, :50, :105).
//
// `statement-capture-full.test.ts` shows the shape reader catching a
// session-wide setting and a setting that is not first, but on a synthetic log
// (its "the shape reader catches each thing it is for" block). This suite puts
// the wrong line into the wrapper itself, on a disposable source copy
// (`tests/support/source-mutant.ts`), and drives real production operations
// through it:
//
// - **T04 (a)** `set_config(..., true)` at `tenancy/database.ts:105` becomes
//   `false`, a setting that outlives its transaction;
// - **T04 (b)** the same setting is moved in front of `begin`;
// - each mutant turns the capture's shape check red on the same operations
//   the unmutated copy, loaded the same way in the same run, keeps green;
// - **T04 (c)** one production operation that ends in a whole-transaction
//   `rollback`, the DECISION_INTEGRITY read fault, captured on the shipped
//   wrapper: begin, the local setting, the work, rollback, nothing outside;
// - **T05** the session-wide mutant run through pooled-crossover's own
//   sequence on one backend, red where `pooled-crossover.test.ts:168` and
//   `:206` look, then green on the restored wrapper.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  pathOf,
  type CommandDeclaration,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import * as shipped from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  createStatementLog,
  type RecordedStatement,
  type StatementLog,
} from '../../packages/core-records/src/tenancy/statements.ts';
import { createApi, type AgentExecutor, type ReadExecutor } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  ACCEPTANCE_SECRET,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { createSourceMutant, type SourceMutant } from '../support/source-mutant.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { expectedShape, shapeOf, type Shape } from './statement-capture-cases.ts';

type Wrapper = typeof shipped;

const DATABASE_TS = 'packages/core-records/src/tenancy/database.ts';
const LOCAL_LINE =
  "await tx.unsafe(`select set_config('app.business_id', $1, true)`, [businessId]);";
const BEGIN_THEN_SETTING = [
  '    return (await sql.begin(async (tx) => {',
  '      // Inside the transaction, and nowhere else. `true` is the is_local',
  '      // argument, which is what makes this SET LOCAL rather than SET.',
  `      ${LOCAL_LINE}`,
].join('\n');

/** The three copies: one line changed twice, and once not at all. */
const COPIES = {
  // The same exact-match replacement with nothing replaced, so the control is
  // loaded through the same copy and import path the mutants are.
  unmutated: { file: DATABASE_TS, from: LOCAL_LINE, to: LOCAL_LINE },
  sessionWide: {
    file: DATABASE_TS,
    from: LOCAL_LINE,
    to: LOCAL_LINE.replace('$1, true)', '$1, false)'),
  },
  beforeBegin: {
    file: DATABASE_TS,
    from: BEGIN_THEN_SETTING,
    to: [
      `    ${LOCAL_LINE.replace('tx.unsafe', 'sql.unsafe')}`,
      '    return (await sql.begin(async (tx) => {',
    ].join('\n'),
  },
} as const;

type CopyName = keyof typeof COPIES;

if (serverUrl === undefined) {
  console.warn('wrapper mutation: DATABASE_URL is unset, so nothing below ran.');
}

/** `observe` from statement-capture-cases.ts, over whichever wrapper it is handed. */
function observeOn(wrapper: Wrapper, world: World) {
  const log = createStatementLog();
  const database = wrapper.connect(world.db.appUrl, { source: 'runtime', log, max: 1 });
  const byKey: Readonly<Record<string, string>> = { alpha: world.alpha, bravo: world.bravo };
  const api = createApi({
    database,
    verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET }),
    resolveBusiness: async (key: string) => byKey[key],
    executeRead: executeRead as unknown as ReadExecutor,
    executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
  });
  return {
    log,
    async send(
      name: CommandName,
      body: Readonly<Record<string, unknown>>,
    ): Promise<{ answer: Answer; sent: readonly RecordedStatement[] }> {
      const from = log.entries.length;
      const answer = await call(
        api,
        personPath('alpha', pathOf(name)),
        { operationId: randomUUID(), ...body },
        bearer(world.ada.token),
      );
      return { answer, sent: log.entries.slice(from) };
    },
    close: async () => {
      await database.close();
    },
  };
}

const declared = (name: CommandName): CommandDeclaration => {
  const declaration = COMMAND_SURFACE.find((one) => one.name === name);
  if (declaration === undefined) throw new Error(`wrapper mutation: ${name} is not declared`);
  return declaration;
};

/** Two writes and two reads, each with the matrix's own positive body. */
const OPERATIONS: readonly CommandName[] = [
  'task.create',
  'task.update',
  'task.read',
  'task.board',
];

interface Captured {
  readonly name: CommandName;
  readonly status: number;
  readonly code: string;
  readonly shape: Shape;
}

describe.skipIf(serverUrl === undefined)(
  'T04 (a, b): the wrapper mutated, on real operations',
  () => {
    let harness: Harness;
    const copies = new Map<CopyName, SourceMutant>();
    const runs = new Map<CopyName, readonly Captured[]>();

    /** Every operation through one copy's wrapper, on a fresh logged connection. */
    const capture = async (copy: CopyName): Promise<readonly Captured[]> => {
      const mutant = createSourceMutant(COPIES[copy]);
      copies.set(copy, mutant);
      const observed = observeOn(await mutant.load<Wrapper>(DATABASE_TS), harness.world);
      try {
        // The driver's per-connection type lookup lands on this call, not on a
        // captured one (statement-capture-full.test.ts, its first case).
        await observed.send('session.capabilities', {});
        const captured: Captured[] = [];
        for (const name of OPERATIONS) {
          // eslint-disable-next-line no-await-in-loop -- one connection, one call at a time
          const prepared = await harness.positiveBody(declared(name));
          if (!('body' in prepared)) throw new Error(`wrapper mutation: no body for ${name}`);
          // eslint-disable-next-line no-await-in-loop -- one connection, one call at a time
          const { answer, sent } = await observed.send(name, prepared.body);
          captured.push({ name, status: answer.status, code: answer.code, shape: shapeOf(sent) });
        }
        return captured;
      } finally {
        await observed.close();
      }
    };

    /** What `statement-capture-full.test.ts` asserts of a positive call. */
    const expected = (name: CommandName) => ({
      status: 200,
      code: 'ok',
      shape: expectedShape(declared(name), 'person', 'applied'),
    });

    beforeAll(async () => {
      harness = await createHarness('wrapmut');
      // Both mutants, then the unmutated copy: the restore is a run of its own
      // on the same world after the mutants, not a run from before them.
      runs.set('sessionWide', await capture('sessionWide'));
      runs.set('beforeBegin', await capture('beforeBegin'));
      runs.set('unmutated', await capture('unmutated'));
    }, 180_000);

    afterAll(async () => {
      for (const mutant of copies.values()) mutant.dispose();
      await harness?.close();
    });

    it('keeps the unmutated copy green on every operation, after both mutants ran', () => {
      const run = runs.get('unmutated') ?? [];
      expect(run.map((one) => one.name)).toStrictEqual(OPERATIONS);
      for (const one of run) {
        expect({ status: one.status, code: one.code, shape: one.shape }, one.name).toStrictEqual(
          expected(one.name),
        );
      }
    });

    it('(a) session-wide: the shape check is red on every operation, at sessionWide', () => {
      const run = runs.get('sessionWide') ?? [];
      expect(run).toHaveLength(OPERATIONS.length);
      for (const one of run) {
        const clean = expected(one.name).shape;
        // Red: the full suite's assertion fails on this operation.
        expect(() => expect(one.shape, one.name).toStrictEqual(clean)).toThrow();
        // And fails where it should: the setting is still first after `begin`,
        // but it is the session-wide spelling, and the reader names it.
        expect(one.shape.sessionWide, one.name).toStrictEqual([
          `select set_config('app.business_id', $1, false)`,
        ]);
        expect(one.shape.afterBegin, one.name).toStrictEqual([
          `select set_config('app.business_id', $1, false)`,
        ]);
        expect({ ...one.shape, sessionWide: [], afterBegin: clean.afterBegin }).toStrictEqual(
          clean,
        );
      }
    });

    it('(b) before begin: the shape check is red on every operation, at outside and afterBegin', () => {
      const run = runs.get('beforeBegin') ?? [];
      expect(run).toHaveLength(OPERATIONS.length);
      for (const one of run) {
        const clean = expected(one.name).shape;
        expect(() => expect(one.shape, one.name).toStrictEqual(clean)).toThrow();
        // Every transaction the operation opened was preceded by the setting,
        // sent with no transaction open, and none of them began with it.
        expect(one.shape.outside.length, one.name).toBeGreaterThan(0);
        expect(one.shape.outside, one.name).toStrictEqual(
          Array.from({ length: one.shape.transactions }, () => clean.afterBegin[0]),
        );
        expect(one.shape.afterBegin, one.name).not.toContain(clean.afterBegin[0]);
        // The setting did not reach the transaction, so the server found no
        // tenant in it: the product failed closed rather than answering.
        expect(one.status, one.name).toBe(500);
        expect(
          one.shape.ends.every((end) => end === 'rollback'),
          one.name,
        ).toBe(true);
      }
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'T04 (c): a production operation ending in rollback',
  () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await createHarness('wraproll');
    }, 120_000);

    afterAll(async () => {
      await harness?.close();
    });

    it('captures the DECISION_INTEGRITY read fault as begin, local setting, work, rollback', async () => {
      const { world } = harness;
      const { subject, decided } = await harness.approvedReservation();
      expect(decided.code, 'decide').toBe('ok');
      // One signed payload altered as the owner, triggers off for the statement
      // alone (decision-integrity-read.test.ts, "the named fault").
      await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
      try {
        await world.db.admin.execute(
          `update public.gate_decisions
            set payload = jsonb_set(payload, '{note}', '"approved for something else"')
          where business_id = $1`,
          [world.alpha],
        );
      } finally {
        await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
      }

      const observed = observeOn(shipped, world);
      try {
        await observed.send('session.capabilities', {});
        const { answer, sent } = await observed.send('task.read', { recordId: subject.id });
        expect({ status: answer.status, code: answer.body['code'] }).toStrictEqual({
          status: 500,
          code: 'DECISION_INTEGRITY',
        });
        const shape = shapeOf(sent);
        expect(shape).toMatchObject({
          transactions: 1,
          outside: [],
          afterBegin: [`select set_config('app.business_id', $1, true)`],
          ends: ['rollback'],
          work: [],
          schemaChanging: [],
          sessionWide: [],
        });
        const texts = sent.map((entry) => entry.text.replaceAll(/\s+/gu, ' ').trim());
        expect(texts[0]).toMatch(/^begin\b/iu);
        expect(texts.at(-1)).toMatch(/^rollback$/iu);
        // The work between the setting and the rollback is the read's own.
        expect(texts.slice(2, -1).join('\n')).toMatch(/gate_decisions/u);
      } finally {
        await observed.close();
      }
    }, 120_000);
  },
);

interface Tenant {
  readonly businessId: string;
  readonly member: Member;
}

/** pooled-crossover.test.ts's sequence, on whichever wrapper, reading what :168 and :206 read. */
async function crossover(wrapper: Wrapper) {
  const db: FreshDatabase = await createFreshDatabase({ part: 'x' });
  const log: StatementLog = createStatementLog();
  const pool = wrapper.connectObserved(db.appUrl, { source: 'runtime', log, max: 1 });
  const pids = new Set<number>();
  const settingBetween = async (): Promise<string> => {
    const seen = await pool.betweenTransactions<{ readonly value: string | null; pid: number }>(
      `select current_setting('app.business_id', true) as value, pg_backend_pid() as pid`,
    );
    pids.add(Number(seen[0]?.pid));
    return seen[0]?.value ?? '';
  };
  const enrolTenant = async (key: string): Promise<Tenant> => {
    const businessId = await insertBusiness(pool, key);
    await installSpine(pool, businessId);
    const member = await enrol(pool, businessId, `${key}-worker`);
    await pool.withBusiness(businessId, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'assign');
    });
    return { businessId, member };
  };
  const createTask = async (tenant: Tenant, title: string): Promise<void> => {
    const made = await executeCommand(pool, tenant.businessId, tenant.member.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Parameters<typeof executeCommand>[4]);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  };
  try {
    const alpha = await enrolTenant('alpha');
    const beta = await enrolTenant('beta');
    // :168, after A commits a real task.create.
    await createTask(alpha, 'alpha commits');
    const afterCommit = await settingBetween();
    // B's committed work, as pooled-crossover does before its rollback block.
    await createTask(beta, 'beta after a commit');
    const afterBeta = await settingBetween();
    // :206, after A writes and gives up.
    await pool
      .withBusiness(alpha.businessId, async (tx) => {
        await tx.query(
          `insert into records (business_id, id, record_type_id, data)
             select $1, $2, rt.id, jsonb_build_object('title', 'alpha rolls back')
               from record_types rt where rt.business_id = $1 and rt.key = 'task'`,
          [alpha.businessId, randomUUID()],
        );
        throw new Error('A gives up after writing');
      })
      .catch(() => undefined);
    const afterRollback = await settingBetween();
    return { alpha, beta, afterCommit, afterBeta, afterRollback, pids: [...pids] };
  } finally {
    await pool.close();
    await db.drop();
  }
}

/** A rolled-back transaction alone, on a fresh backend, to see what :206 can see unaided. */
async function rollbackAlone(wrapper: Wrapper): Promise<string> {
  const db: FreshDatabase = await createFreshDatabase({ part: 'x' });
  const pool = wrapper.connectObserved(db.appUrl, { source: 'runtime', max: 1 });
  try {
    const businessId = randomUUID();
    await pool
      .withBusiness(businessId, async () => {
        throw new Error('gives up');
      })
      .catch(() => undefined);
    const seen = await pool.betweenTransactions<{ readonly value: string | null }>(
      `select current_setting('app.business_id', true) as value`,
    );
    return seen[0]?.value ?? '';
  } finally {
    await pool.close();
    await db.drop();
  }
}

describe.skipIf(serverUrl === undefined)(
  'T05: the session-wide mutant against pooled crossover',
  () => {
    let mutant: SourceMutant;

    afterAll(() => {
      mutant?.dispose();
    });

    it('is red at :168 and :206 under the mutant, then green on the restored wrapper', async () => {
      mutant = createSourceMutant(COPIES.sessionWide);
      const red = await crossover(await mutant.load<Wrapper>(DATABASE_TS));
      mutant.dispose();
      // One backend throughout, or the reading is about a different connection.
      expect(red.pids).toHaveLength(1);
      // :168 is `expect(await settingBetween()).toBe('')`: red, and A's id is what leaked.
      expect(() => expect(red.afterCommit).toBe('')).toThrow();
      expect(red.afterCommit).toBe(red.alpha.businessId);
      expect(red.afterBeta).toBe(red.beta.businessId);
      // :206, the same assertion after A's rollback: red, and it is B's id that
      // is still there. A's own session-wide setting went with A's rollback;
      // what :206 reads is the leftover of the last commit.
      expect(() => expect(red.afterRollback).toBe('')).toThrow();
      expect(red.afterRollback).toBe(red.beta.businessId);

      // The restore: the shipped module, which the dispose above left untouched.
      const green = await crossover(shipped);
      expect(green.pids).toHaveLength(1);
      expect({
        afterCommit: green.afterCommit,
        afterBeta: green.afterBeta,
        afterRollback: green.afterRollback,
      }).toStrictEqual({ afterCommit: '', afterBeta: '', afterRollback: '' });
    }, 180_000);

    it('shows a rollback alone undoing a session-wide setting, so :206 depends on the commit before it', async () => {
      const leaky = createSourceMutant(COPIES.sessionWide);
      try {
        expect(await rollbackAlone(await leaky.load<Wrapper>(DATABASE_TS))).toBe('');
      } finally {
        leaky.dispose();
      }
    }, 60_000);
  },
);
