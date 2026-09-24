// SPDX-License-Identifier: AGPL-3.0-only
//
// FR3-DECIDE: final review round 3 at 61c167a. Each case was run red at that
// head first (PROVE-BEFORE-FIX, 24 Sep 2026).
//
// R3-AUTHORITY-6 = R3-RUNTIME-7 = R3-SURFACE-9, R2-AUTHORITY-33 (regressed) and
// R1-RUNTIME-53 (regressed). The R2-AUTHORITY-33 fix lower-cased `versionId`
// in `decide()` before anything had typed it, so a task.decide with versionId
// absent or not a string threw there and answered 503. It is now refused by
// name at the typed-identifier door.
//
// R3-SURFACE-8. task.create bound a non-string `parentId`, `board` or
// `boardSection` and answered 503. Each is now refused by name at the same door.
//
// R3-THERMO-25. A replay re-judges authority through `prepareCommand`, and the
// declaration it passes still carried `serialise`, so a replayed reparent
// waited behind the business's placement lock. A replay locks nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Caller } from '../acceptance/world.ts';
import {
  createIdentWorld,
  type IdentWorld,
  type RawAnswer,
} from '../acceptance/ident-audit-cases.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';

const serverUrl = databaseUrlFromEnvironment();

type Body = Record<string, unknown>;

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

describe.skipIf(serverUrl === undefined)('FR3-DECIDE: typed operands and the replay lock', () => {
  let w: IdentWorld;
  let ada: Caller;

  beforeAll(async () => {
    w = await createIdentWorld('fr3_decide');
    ada = w.h.world.ada;
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const admin = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly T[]> => await w.h.world.db.admin.execute<T>(sql, [...parameters]);

  /** Everything a refused operand must leave as it was, business-wide. */
  const domain = async (): Promise<string> =>
    JSON.stringify(
      await admin(
        `select (select count(*) from public.records where business_id = $1) as records,
                (select coalesce(sum(revision), 0) from public.records where business_id = $1) as revisions,
                (select count(*) from public.gates where business_id = $1) as gates,
                (select count(*) from public.gates where business_id = $1 and state = 'pending') as pending,
                (select count(*) from public.gate_decisions where business_id = $1) as decisions`,
        [w.h.world.alpha],
      ),
    );

  const audited = async (operationId: string) =>
    await admin<{ outcome: string; refusal_code: string | null }>(
      `select outcome, refusal_code from public.audit_events where operation_id = $1`,
      [operationId],
    );

  /** Refused with `code` naming `names`, one `refused` row, no `failed` one, nothing moved. */
  async function refusedCleanly(
    send: (body: Body) => Promise<RawAnswer>,
    body: Body,
    names: readonly string[],
  ): Promise<void> {
    const operationId = randomUUID();
    const before = await domain();
    const answer = await send({ ...body, operationId });
    expect({ status: answer.status, code: answer.code }, answer.text).toStrictEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });
    expect(answer.body['names']).toStrictEqual(names);
    expect(
      (await audited(operationId)).map((row) => [row.outcome, row.refusal_code]),
    ).toStrictEqual([['refused', 'FIELD_VALUE_INVALID']]);
    expect(await domain()).toBe(before);
  }

  const person = (name: CommandName) => (body: Body) => w.person(ada, name, body);

  async function taskAt(title: string): Promise<{ id: string; revision: number }> {
    const made = await w.person(ada, 'task.create', { fields: { title } });
    expect(made.code, made.text).toBe('ok');
    return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  }

  describe('task.decide versionId absent or not a string (R3-AUTHORITY-6, R3-RUNTIME-7, R3-SURFACE-9)', () => {
    for (const [label, versionId] of [
      ['absent', undefined],
      ['5', 5],
      ['null', null],
      ['true', true],
      ['{}', {}],
    ] as const) {
      it(`versionId ${label}: FIELD_VALUE_INVALID naming versionId, the gate still pending`, async () => {
        const proposed = await w.propose(`decide version ${label}`);
        const body: Body = { gateId: proposed.gateId, decision: 'approve', note: 'x' };
        if (versionId !== undefined) body['versionId'] = versionId;
        await refusedCleanly(person('task.decide'), body, ['versionId']);
      });
    }

    it('gateId and versionId both 5: both named, in order', async () => {
      await refusedCleanly(
        person('task.decide'),
        { gateId: 5, versionId: 5, decision: 'approve', note: 'x' },
        ['gateId', 'versionId'],
      );
    });

    it('an upper-case versionId of the gate’s own version still decides (R2-AUTHORITY-33)', async () => {
      const proposed = await w.propose('decide upper');
      const answer = await w.person(ada, 'task.decide', {
        gateId: proposed.gateId.toUpperCase(),
        versionId: proposed.versionId.toUpperCase(),
        decision: 'approve',
        note: 'x',
      });
      expect(answer.code, answer.text).toBe('ok');
    });
  });

  describe('task.create parentId, board or boardSection not a string (R3-SURFACE-8)', () => {
    for (const [field, value] of [
      ['parentId', 5],
      ['parentId', true],
      ['board', 5],
      ['board', {}],
      ['boardSection', 5],
    ] as const) {
      it(`${field} ${JSON.stringify(value)}: FIELD_VALUE_INVALID naming ${field}`, async () => {
        await refusedCleanly(
          person('task.create'),
          { fields: { title: `create ${field}` }, [field]: value },
          [field],
        );
      });
    }

    it('parentId and board null still create a top-level task', async () => {
      const made = await w.person(ada, 'task.create', {
        fields: { title: 'create nulls' },
        parentId: null,
        board: null,
      });
      expect(made.code, made.text).toBe('ok');
    });
  });

  describe('a replay takes no placement lock (R3-THERMO-25)', () => {
    it('a replayed reparent answers while another transaction holds task.placement', async () => {
      const parent = await taskAt('replay parent');
      const child = await taskAt('replay child');
      const body = {
        operationId: randomUUID(),
        recordId: child.id,
        expectedRevision: child.revision,
        parentId: parent.id,
      };
      const first = await w.person(ada, 'task.reparent', body);
      expect(first.code, first.text).toBe('ok');

      const url = new URL(serverUrl ?? '');
      url.pathname = `/${w.h.world.db.name}`;
      const holder = connectAsAdmin(url.toString(), { source: 'harness' });
      const { held: released, release } = barrier();
      const { held: holding, release: held } = barrier();
      const holderDone = holder.transaction(async (execute) => {
        await execute(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `task.placement:${w.h.world.alpha}`,
        ]);
        held();
        await released;
      });
      try {
        await holding;
        const replay = w.person(ada, 'task.reparent', body);
        const outcome = await Promise.race([
          replay.then((answer) => answer),
          new Promise<'blocked'>((resolve) => {
            setTimeout(() => resolve('blocked'), 3_000);
          }),
        ]);
        expect(outcome === 'blocked' ? 'blocked' : outcome.status).toBe(first.status);
        if (outcome !== 'blocked') {
          expect(outcome.body['recordId']).toBe(first.body['recordId']);
        }
        release();
        await replay;
      } finally {
        release();
        await holderDone;
        await holder.close();
      }
      expect((await audited(body.operationId)).map((row) => row.outcome).toSorted()).toStrictEqual([
        'applied',
        'replayed',
      ]);
    });
  });
});
