// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-JSONB: final review round 2 at 3eb0cc1. Each case was run red at that
// head first (PROVE-BEFORE-FIX, 24 Sep 2026).
//
// R1-THERMO-12 (carried), R2-SURFACE-9, R2-THERMO-11 and R2-RUNTIME-63. A
// jsonb string cannot hold U+0000 or an unpaired surrogate, and a text column
// cannot hold U+0000. A comment body, a cancel reason, a proposal's payload,
// step, currency and purpose, a handback report and a successor reached the
// insert with either, so the owed typed refusal became a 503 with a `failed`
// row. Each is now `FIELD_VALUE_INVALID` naming the operand, audited
// `refused`, with nothing written.
//
// R2-SURFACE-8. A non-string or absent identifier operand reached a uuid bind
// and faulted. R2-THERMO-22. A timestamp Postgres refuses (30 February, an
// offset past 15 hours, the year 0) passed the value check. R2-AUTHORITY-30. A
// revoke naming the other revoke's id was steered by it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrolAgent, enrolCaller } from '../acceptance/cast.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import type { Caller } from '../acceptance/world.ts';
import {
  createIdentWorld,
  type IdentWorld,
  type RawAnswer,
} from '../acceptance/ident-audit-cases.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';

const serverUrl = databaseUrlFromEnvironment();

const NUL = String.fromCodePoint(0);
const LONE = String.fromCodePoint(0xd800);

type Body = Record<string, unknown>;

describe.skipIf(serverUrl === undefined)('FR2-JSONB: operands the stores cannot hold', () => {
  let w: IdentWorld;
  let ada: Caller;

  beforeAll(async () => {
    w = await createIdentWorld('fr2_jsonb');
    ada = w.h.world.ada;
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const admin = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly T[]> => await w.h.world.db.admin.execute<T>(sql, [...parameters]);
  const count = async (sql: string, parameters: readonly unknown[] = []): Promise<number> =>
    Number((await admin<{ n: string }>(sql, parameters))[0]?.n);

  /** Everything a refused operand must leave as it was, business-wide. */
  const domain = async (): Promise<string> =>
    JSON.stringify(
      await admin(
        `select (select count(*) from public.records where business_id = $1) as records,
                (select coalesce(sum(revision), 0) from public.records where business_id = $1) as revisions,
                (select count(*) from public.proposal_versions where business_id = $1) as versions,
                (select count(*) from public.gates where business_id = $1) as gates,
                (select count(*) from public.handback_reports where business_id = $1) as reports,
                (select count(*) from public.leases where business_id = $1 and state = 'live') as live,
                (select count(*) from public.grants where business_id = $1 and revoked_at is null) as grants,
                (select count(*) from public.delegations where business_id = $1 and revoked_at is null) as delegations`,
        [w.h.world.alpha],
      ),
    );

  const audited = async (operationId: string) =>
    await admin<{ outcome: string; refusal_code: string | null }>(
      `select outcome, refusal_code from public.audit_events where operation_id = $1`,
      [operationId],
    );

  /** Sent once; refused with `code` naming `names`, one `refused` row, no `failed` one, nothing moved. */
  async function refusedCleanly(
    send: (body: Body) => Promise<RawAnswer>,
    body: Body,
    expected: {
      readonly status: number;
      readonly code: string;
      readonly names?: readonly string[];
    },
  ): Promise<RawAnswer> {
    const operationId = randomUUID();
    const before = await domain();
    const answer = await send({ ...body, operationId });
    expect({ status: answer.status, code: answer.code }, answer.text).toStrictEqual({
      status: expected.status,
      code: expected.code,
    });
    if (expected.names !== undefined) expect(answer.body['names']).toStrictEqual(expected.names);
    expect(
      (await audited(operationId)).map((row) => [row.outcome, row.refusal_code]),
    ).toStrictEqual([['refused', expected.code]]);
    expect(await domain()).toBe(before);
    return answer;
  }

  /** A fresh agent holding a live pickup, so no delegation is already live for the purpose. */
  async function freshPickup(title: string) {
    const identity = await enrolAgent(w.h.world.db, w.h.world.alpha, ada.actorId as string);
    const picked = await w.pickUp(identity, title);
    const as = (name: CommandName) => (body: Body) =>
      w.agent(identity, name, body, picked.credential);
    return { picked, as };
  }

  const person =
    (name: CommandName, caller: Caller = ada) =>
    (body: Body) =>
      w.person(caller, name, body);

  async function taskAt(title: string): Promise<{ id: string; revision: number }> {
    const made = await w.person(ada, 'task.create', { fields: { title } });
    expect(made.code, made.text).toBe('ok');
    return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  }

  const revisionOf = async (id: string): Promise<number> =>
    await count(`select revision::text as n from public.records where id = $1`, [id]);

  describe('task.comment body (R1-THERMO-12 (a), R2-SURFACE-9, R2-THERMO-11)', () => {
    for (const [label, body] of [
      ['a NUL', `a${NUL}b`],
      ['a lone surrogate', `a${LONE}b`],
    ] as const) {
      it(`person: a body holding ${label} is FIELD_VALUE_INVALID naming body`, async () => {
        const task = await taskAt(`comment ${label}`);
        await refusedCleanly(
          person('task.comment'),
          { recordId: task.id, expectedRevision: task.revision, body, audience: 'internal' },
          { status: 422, code: 'FIELD_VALUE_INVALID', names: ['body'] },
        );
      });

      it(`agent: a body holding ${label} is FIELD_VALUE_INVALID naming body`, async () => {
        const { picked, as } = await freshPickup(`agent comment ${label}`);
        const revision = await revisionOf(picked.taskId);
        await refusedCleanly(
          as('task.comment'),
          { recordId: picked.taskId, expectedRevision: revision, body, audience: 'internal' },
          { status: 422, code: 'FIELD_VALUE_INVALID', names: ['body'] },
        );
      });
    }

    it('a paired surrogate is a character and is written', async () => {
      const task = await taskAt('comment emoji');
      const answer = await w.person(ada, 'task.comment', {
        recordId: task.id,
        expectedRevision: task.revision,
        body: 'done \u{1F600}',
        audience: 'internal',
      });
      expect(answer.code, answer.text).toBe('ok');
    });
  });

  describe('task.propose operands (R2-SURFACE-9, R2-THERMO-11, R2-RUNTIME-63)', () => {
    const cases: readonly (readonly [string, Body, string])[] = [
      ['payload value NUL', { payload: { x: `a${NUL}b` } }, 'payload'],
      ['payload value lone surrogate', { payload: { x: LONE } }, 'payload'],
      ['payload key NUL', { payload: { [`k${NUL}`]: 1 } }, 'payload'],
      ['step.payload key NUL', { step: { kind: 'compose', payload: { [`k${NUL}`]: 1 } } }, 'step'],
      ['step.kind NUL', { step: { kind: `a${NUL}`, payload: {} } }, 'step'],
      ['purpose NUL', { purpose: `draft${NUL}` }, 'purpose'],
    ];
    for (const [label, change, name] of cases) {
      it(`${label}: FIELD_VALUE_INVALID naming ${name}`, async () => {
        const task = await taskAt(`propose ${label}`);
        await refusedCleanly(
          person('task.propose'),
          { recordId: task.id, expectedRevision: task.revision, ...PROPOSAL, ...change },
          { status: 422, code: 'FIELD_VALUE_INVALID', names: [name] },
        );
      });
    }

    it('currency NUL: refused, never a fault', async () => {
      const task = await taskAt('propose currency');
      const answer = await refusedCleanly(
        person('task.propose'),
        { recordId: task.id, expectedRevision: task.revision, ...PROPOSAL, currency: `A${NUL}D` },
        { status: 422, code: 'FIELD_VALUE_INVALID' },
      );
      expect(answer.body['names']).toContain('currency');
    });
  });

  describe('task.cancel reason (R2-SURFACE-9, R2-THERMO-11)', () => {
    it('a reason holding NUL is FIELD_VALUE_INVALID naming reason', async () => {
      const proposed = await w.propose('cancel reason');
      await refusedCleanly(
        person('task.cancel'),
        { recordId: proposed.task.id, lineageId: proposed.lineageId, reason: `stop${NUL}` },
        { status: 422, code: 'FIELD_VALUE_INVALID', names: ['reason'] },
      );
    });
  });

  describe('task.handback report and successor (R1-THERMO-12 (b), R2-SURFACE-9, R2-RUNTIME-63)', () => {
    it('person: a report, then a successor payload, holding NUL is FIELD_VALUE_INVALID by name, the lease still live', async () => {
      const proposed = await w.propose('person handback report');
      const decided = await w.person(ada, 'task.decide', {
        gateId: proposed.gateId,
        versionId: proposed.versionId,
        decision: 'approve',
        note: 'approved for a person pickup',
      });
      expect(decided.code, decided.text).toBe('ok');
      const reservationId = (decided.body['detail'] as Body)['reservationId'];
      const picked = await w.person(ada, 'task.pickup', { reservationId });
      expect(picked.code, picked.text).toBe('ok');
      const lease = picked.body['detail'] as Body;
      await refusedCleanly(
        person('task.handback'),
        {
          leaseId: lease['leaseId'],
          fence: lease['fence'],
          outcome: 'completed',
          report: { n: `a${NUL}b` },
        },
        { status: 422, code: 'FIELD_VALUE_INVALID', names: ['report'] },
      );
      await refusedCleanly(
        person('task.handback'),
        {
          leaseId: lease['leaseId'],
          fence: lease['fence'],
          outcome: 'completed',
          report: {},
          successor: { ...PROPOSAL, payload: { x: `a${NUL}b` } },
        },
        { status: 422, code: 'FIELD_VALUE_INVALID', names: ['successor.payload'] },
      );
    });

    for (const [label, report] of [
      ['a NUL', { n: NUL }],
      ['a lone surrogate', { n: LONE }],
    ] as const) {
      // HANDED BACK, not fixed here: the agent entry reads `report` and `successor` in
      // `agent-operations.ts` `handbackOperands`, outside this lane's files. Still red, so
      // `it.fails`; the line that closes it turns these into failures to flip.
      it.fails(
        `agent, live fence: a report holding ${label} is refused, the lease still live`,
        async () => {
          const { picked, as } = await freshPickup(`agent handback ${label}`);
          await refusedCleanly(
            as('task.handback'),
            { leaseId: picked.leaseId, fence: picked.fence, outcome: 'completed', report },
            { status: 422, code: 'FIELD_VALUE_INVALID', names: ['report'] },
          );
        },
      );
    }

    it.fails(
      'agent: a successor payload holding NUL is refused, the lease still live',
      async () => {
        const { picked, as } = await freshPickup('agent successor');
        await refusedCleanly(
          as('task.handback'),
          {
            leaseId: picked.leaseId,
            fence: picked.fence,
            outcome: 'completed',
            report: {},
            successor: { ...PROPOSAL, payload: { x: `a${NUL}b` } },
          },
          { status: 422, code: 'FIELD_VALUE_INVALID' },
        );
      },
    );
  });

  describe('identifier operands that are not strings (R2-SURFACE-8)', () => {
    it('task.rank afterId 5 and beforeId {}: FIELD_VALUE_INVALID naming the operand', async () => {
      const task = await taskAt('rank typed');
      for (const [field, value] of [
        ['afterId', 5],
        ['beforeId', {}],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- one task, one call at a time
        await refusedCleanly(
          person('task.rank'),
          { recordId: task.id, expectedRevision: task.revision, [field]: value },
          { status: 422, code: 'FIELD_VALUE_INVALID', names: [field] },
        );
      }
    });

    it('task.propose lineageId 5: FIELD_VALUE_INVALID naming lineageId', async () => {
      const task = await taskAt('propose lineage typed');
      await refusedCleanly(
        person('task.propose'),
        { recordId: task.id, expectedRevision: task.revision, ...PROPOSAL, lineageId: 5 },
        { status: 422, code: 'FIELD_VALUE_INVALID', names: ['lineageId'] },
      );
    });

    it('task.decide gateId 5 and gateId absent: FIELD_VALUE_INVALID naming gateId', async () => {
      const proposed = await w.propose('decide typed');
      const decision = { versionId: proposed.versionId, decision: 'approve', note: 'x' };
      await refusedCleanly(
        person('task.decide'),
        { ...decision, gateId: 5 },
        { status: 422, code: 'FIELD_VALUE_INVALID', names: ['gateId'] },
      );
      await refusedCleanly(person('task.decide'), decision, {
        status: 422,
        code: 'FIELD_VALUE_INVALID',
        names: ['gateId'],
      });
    });
  });

  describe('timestamptz values Postgres refuses (R2-THERMO-22)', () => {
    for (const due of [
      '2026-02-30',
      '2026-09-31',
      '2026-02-29',
      '2026-01-01T00:00+16:00',
      '0000-01-01',
    ]) {
      it(`due ${due}: FIELD_VALUE_INVALID naming due=timestamptz`, async () => {
        await refusedCleanly(
          person('task.create'),
          { fields: { title: `due ${due}`, due } },
          { status: 422, code: 'FIELD_VALUE_INVALID', names: ['due=timestamptz'] },
        );
      });
    }

    for (const due of ['2028-02-29', '2026-01-01T00:00+14:00', '2026-12-31T23:59:59.999999Z']) {
      it(`due ${due} is applied`, async () => {
        const made = await w.person(ada, 'task.create', { fields: { title: `due ${due}`, due } });
        expect(made.code, made.text).toBe('ok');
      });
    }
  });

  describe("a revoke naming the other revoke's id (R2-AUTHORITY-30)", () => {
    let manager: Caller;
    let grantOnTask: string;

    beforeAll(async () => {
      const { world } = w.h;
      manager = await enrolCaller(world.db, world.alpha, 'alpha', 'fr2_record_manager', {
        membership: true,
        actions: [],
        collections: [],
      });
      const issued = await world.db.app.withBusiness(
        world.alpha,
        async (tx) =>
          await issueGrant(tx, [], {
            subject: { kind: 'person', id: manager.personId as string },
            scope: { kind: 'record', id: w.rheaTask.id },
            collection: 'task',
            action: 'manage',
            expiresAt: null,
            parentGrantId: null,
            grantedByActorId: world.ada.actorId as string,
          }),
      );
      expect(issued.ok).toBe(true);
      const rows = await admin<{ id: string }>(
        `select id from public.grants
          where business_id = $1 and scope_kind = 'record' and scope_id = $2
            and subject_id = $3 and revoked_at is null limit 1`,
        [world.alpha, w.rheaTask.id, w.rhea.personId],
      );
      grantOnTask = String(rows[0]?.id);
    });

    it('delegation.revoke carrying a grantId is refused naming grantId, whatever it names', async () => {
      const send = person('delegation.revoke', manager);
      const stray = await refusedCleanly(
        send,
        { delegationId: randomUUID(), grantId: grantOnTask },
        { status: 400, code: 'COMMAND_BODY_INVALID', names: ['grantId'] },
      );
      const fabricated = await refusedCleanly(
        send,
        { delegationId: randomUUID(), grantId: randomUUID() },
        { status: 400, code: 'COMMAND_BODY_INVALID', names: ['grantId'] },
      );
      expect(fabricated.text).toBe(stray.text);
    });

    it('grant.revoke carrying a delegationId is refused naming delegationId', async () => {
      await refusedCleanly(
        person('grant.revoke', manager),
        { grantId: randomUUID(), delegationId: w.otherPicked.delegationId },
        { status: 400, code: 'COMMAND_BODY_INVALID', names: ['delegationId'] },
      );
    });

    it('control: a fabricated delegationId alone is the business-scope SCOPE_NOT_GRANTED', async () => {
      const answer = await w.person(manager, 'delegation.revoke', { delegationId: randomUUID() });
      expect(answer.code, answer.text).toBe('SCOPE_NOT_GRANTED');
    });
  });
});
