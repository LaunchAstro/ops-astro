// SPDX-License-Identifier: AGPL-3.0-only
//
// T04 and M03 over every exported operation, not a sample of them.
//
// `runtime-statements.test.ts` captures six operations and says so: it proves
// the shape a serving transaction has, and makes no coverage claim. This suite
// is the coverage claim. It reads the operation list from `COMMAND_SURFACE` at
// run time, so an operation added to the surface is a case here the moment it
// is declared, and one with no positive body is a failure rather than a gap.
//
// Each operation is called twice through the real application on a connection
// of its own (`statement-capture-cases.ts`): once by a caller who may perform
// it, with the matrix's own positive body, and once by a member who holds no
// grant, which the envelope refuses. Each call's statements are read into one
// shape and compared whole: one transaction, the business set locally as its
// first statement, nothing sent outside it, no session-wide setting, nothing
// that changes the schema, an audit event, and the envelope's work savepoint
// released on success and rolled back on refusal. The refusal still commits,
// because the refusal's audit event is kept (I13).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  type CommandDeclaration,
} from '../../packages/core-records/src/commands/surface.ts';
import { createStatementLog } from '../../packages/core-records/src/tenancy/statements.ts';
import { serverUrl } from '../acceptance/world.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  AGENT_PATH_RECIPES,
  AGENT_RECIPES,
  DRIVER_TYPE_LOOKUP,
  expectedShape,
  observe,
  shapeOf,
  type CapturedCall,
  type Observed,
} from './statement-capture-cases.ts';

if (serverUrl === undefined) {
  console.warn('statement capture: DATABASE_URL is unset, so nothing below ran.');
}

const OPERATIONS = COMMAND_SURFACE.map((declaration) => [declaration.name, declaration] as const);
const captured = { positive: new Set<string>(), refusal: new Set<string>() };

/** The positive call: the matrix's body, or the agent journey the matrix points to. */
async function positiveCall(
  harness: Harness,
  declaration: CommandDeclaration,
): Promise<CapturedCall> {
  const prepared = await harness.positiveBody(declaration);
  if ('body' in prepared) return { name: declaration.name, prefix: 'person', body: prepared.body };
  const recipe = AGENT_RECIPES[declaration.name];
  if (recipe === undefined) {
    throw new Error(
      `capture: no positive case for ${declaration.name}; the matrix says "${prepared.exception}"`,
    );
  }
  return { name: declaration.name, ...(await recipe(harness)) };
}

describe.skipIf(serverUrl === undefined)('T04/M03 over the whole exported inventory', () => {
  let harness: Harness;
  let observed: Observed;
  let first: Awaited<ReturnType<Observed['send']>>;

  beforeAll(async () => {
    harness = await createHarness('capturefull');
    observed = observe(harness.world);
    // The connection's first call, sent before any captured one so the
    // driver's per-connection type lookup lands here and is asserted below.
    first = await observed.send({ name: 'session.capabilities', prefix: 'person', body: {} });
  }, 120_000);

  afterAll(async () => {
    console.log(
      `statement capture: ${COMMAND_SURFACE.length} operations in the registry, ` +
        `${captured.positive.size} captured positive, ${captured.refusal.size} captured refusal; ` +
        `not captured positive: ${
          COMMAND_SURFACE.filter((one) => !captured.positive.has(one.name))
            .map((one) => one.name)
            .join(', ') || 'none'
        }`,
    );
    await observed?.close();
    await harness?.close();
  });

  it("sends only the driver's type lookup outside a transaction, once, on connecting", () => {
    const declaration = COMMAND_SURFACE.find((one) => one.name === 'session.capabilities');
    expect(first.answer.code).toBe('ok');
    expect(shapeOf(first.sent)).toStrictEqual({
      ...expectedShape(declaration as CommandDeclaration, 'person', 'applied'),
      outside: [DRIVER_TYPE_LOOKUP],
    });
  });

  // Timeout only (TEST-TIMEOUTS): prepares a positive body for every operation,
  // one at a time against the database, and ran past the 5 s default while the
  // machine was busy (green run 1, 5003 ms). Assertions unchanged.
  it('has a positive case for every operation, and a recipe only where the matrix has none', async () => {
    const without: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop -- bodies share one world
      const prepared = await harness.positiveBody(declaration);
      if ('exception' in prepared) without.push(declaration.name);
    }
    expect(without.toSorted()).toStrictEqual(Object.keys(AGENT_RECIPES).toSorted());
    expect(new Set(COMMAND_SURFACE.map((one) => one.name)).size).toBe(COMMAND_SURFACE.length);
  }, 30_000);

  describe('a positive call, by a caller who may perform it', () => {
    // Timeout only (TEST-TIMEOUTS): task.assign and task.triage ran past the 5 s
    // default while the machine was busy and pass alone. Assertions unchanged.
    it.each(OPERATIONS)(
      '%s',
      async (_name, declaration) => {
        const call = await positiveCall(harness, declaration);
        const { answer, sent } = await observed.send(call);
        expect({ status: answer.status, code: answer.code, shape: shapeOf(sent) }).toStrictEqual({
          status: 200,
          code: 'ok',
          shape: expectedShape(declaration, call.prefix, 'applied'),
        });
        captured.positive.add(declaration.name);
      },
      30_000,
    );
  });

  describe('the agent path, for an operation a person also performs', () => {
    it.each(OPERATIONS.filter(([name]) => AGENT_PATH_RECIPES[name] !== undefined))(
      '%s',
      async (_name, declaration) => {
        const recipe = AGENT_PATH_RECIPES[declaration.name];
        if (recipe === undefined) throw new Error(`capture: no agent recipe ${declaration.name}`);
        const call: CapturedCall = { name: declaration.name, ...(await recipe(harness)) };
        const { answer, sent } = await observed.send(call);
        expect({ status: answer.status, code: answer.code, shape: shapeOf(sent) }).toStrictEqual({
          status: 200,
          code: 'ok',
          shape: expectedShape(declaration, 'agent', 'applied'),
        });
      },
    );
  });

  describe('a refusal, by a member who holds no grant', () => {
    // Timeout only (TEST-TIMEOUTS): task.assign and task.triage ran past the 5 s
    // default while the machine was busy and pass alone. Assertions unchanged.
    it.each(OPERATIONS)(
      '%s',
      async (_name, declaration) => {
        // `session.capabilities` asks for membership and nothing else, so the
        // member it refuses is the verified login with no membership at all.
        const caller =
          declaration.name === 'session.capabilities' ? harness.world.orphan : harness.world.noah;
        const call: CapturedCall = {
          name: declaration.name,
          prefix: 'person',
          body: harness.probeBody(declaration),
          token: caller.token,
        };
        const { answer, sent } = await observed.send(call);
        expect(answer.code, JSON.stringify(answer.body)).not.toBe('ok');
        expect(shapeOf(sent)).toStrictEqual(
          expectedShape(
            declaration,
            'person',
            caller === harness.world.orphan ? 'unresolved' : 'refused',
          ),
        );
        captured.refusal.add(declaration.name);
      },
      30_000,
    );

    it('task.pickup on the agent prefix, for a reservation nobody approved', async () => {
      const declaration = COMMAND_SURFACE.find((one) => one.name === 'task.pickup');
      const { answer, sent } = await observed.send({
        name: 'task.pickup',
        prefix: 'agent',
        body: { reservationId: randomUUID() },
      });
      expect(answer.code).toBe('RESERVATION_NOT_CLAIMABLE');
      expect(shapeOf(sent)).toStrictEqual(
        expectedShape(declaration as CommandDeclaration, 'agent', 'refused'),
      );
    });
  });

  describe('M03: the capture is real, and the application sent no schema change', () => {
    it('holds the writes and reads the operations made', () => {
      const text = observed.log.entries.map((entry) => entry.text.toLowerCase()).join('\n');
      expect(observed.log.entries.length).toBeGreaterThan(COMMAND_SURFACE.length * 10);
      for (const made of [
        /insert into (public\.)?records/u,
        /update (public\.)?records/u,
        /insert into (public\.)?operations/u,
        /insert into (public\.)?audit_events/u,
      ]) {
        expect(text).toMatch(made);
      }
    });

    it('holds nothing outside a transaction but the one driver lookup', () => {
      expect(shapeOf(observed.log.entries).outside).toStrictEqual([DRIVER_TYPE_LOOKUP]);
    });

    it('holds nothing the log cannot clear of changing the schema', () => {
      expect(observed.log.schemaChanging().map((entry) => entry.text)).toStrictEqual([]);
    });
  });
});

/** One synthetic capture, read the way the suite reads a real one. */
const read = (...statements: string[]) => {
  const log = createStatementLog();
  for (const statement of statements) log.record('runtime', statement);
  return shapeOf(log.entries);
};

describe('the shape reader catches each thing it is for', () => {
  const local = `select set_config('app.business_id', $1, true)`;

  it('reads a clean transaction as clean', () => {
    expect(read('begin', local, 'select 1', 'commit')).toMatchObject({
      transactions: 1,
      outside: [],
      afterBegin: [local],
      ends: ['commit'],
      schemaChanging: [],
      sessionWide: [],
    });
  });

  it('reports a statement outside the transaction and a second transaction', () => {
    const shape = read('select 1', 'begin', local, 'commit', 'begin', local, 'rollback');
    expect(shape.outside).toStrictEqual(['select 1']);
    expect(shape.transactions).toBe(2);
    expect(shape.ends).toStrictEqual(['commit', 'rollback']);
  });

  it('does not read a savepoint rollback as the end of the transaction', () => {
    const shape = read(
      'begin',
      local,
      'savepoint command_work',
      'rollback to savepoint command_work',
      'insert into audit_events values (1)',
      'commit',
    );
    expect(shape).toMatchObject({ outside: [], ends: ['commit'], audited: 'audit_events' });
    expect(shape.work).toStrictEqual([
      'savepoint command_work',
      'rollback to savepoint command_work',
    ]);
  });

  it('reports a setting that is not first, a session-wide one and a set', () => {
    const shape = read(
      'begin',
      'select 1',
      `select set_config('app.business_id', $1, false)`,
      'set app.business_id = 1',
      'commit',
    );
    expect(shape.afterBegin).toStrictEqual(['select 1']);
    expect(shape.sessionWide).toHaveLength(2);
  });

  it('reports schema changes, opaque ones included', () => {
    const shape = read(
      'begin',
      local,
      'create index i on records (id)',
      'do $$ begin end $$',
      'commit',
    );
    expect(shape.schemaChanging).toStrictEqual([
      'ddl: create index i on records (id)',
      'opaque: do $$ begin end $$',
    ]);
  });
});
