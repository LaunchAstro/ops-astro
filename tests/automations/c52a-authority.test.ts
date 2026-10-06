// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's authority cases through the real API route (U36): the refusal for
// `automation:manage`, the agent refused, the audit readback, the isolation
// crossings and the surface parity. The world is `registry-world.ts`; the
// command cases are in `c52a-commands.test.ts`.
//
// The business crossing is real: bravo has its own definition, version,
// activation and standing approval, adopted through the routes by its own
// administrator; alpha's ids sent from bravo are answered exactly as
// fabricated ones are, and bravo's attempts stop none of alpha's firing. The
// client crossing is a person holding every key at one real client's scope.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOccurrence, dispatchOccurrence } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { Answer } from '../api/fixture.ts';
import { starter } from './firing.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const C52A = ['activation.adopt', 'activation.roll_back', 'activation.turn_off', 'approval.revoke'];

const row = (name: string): readonly unknown[] => {
  const one = COMMAND_SURFACE.find((command) => command.name === name);
  return [one?.kind, one?.collection, one?.action, one?.agent, one?.authorisedOn];
};

/** The answer as a caller sees it, less the attempt identity each request mints. */
const seen = (answer: Answer): unknown => {
  const { operationId: _attempt, ...body } = answer.body;
  return [answer.status, body];
};

interface Adopted {
  readonly activationId: string;
  readonly second: string;
  readonly approvalId: string;
  readonly revision: number;
}

type Bodies = (readonly [string, Record<string, unknown>])[];

const bodies = (one: Adopted): Bodies => [
  [
    'activation.adopt',
    { activationId: one.activationId, versionId: one.second, expectedRevision: one.revision },
  ],
  ['activation.roll_back', { activationId: one.activationId, expectedRevision: one.revision }],
  ['activation.turn_off', { activationId: one.activationId, expectedRevision: one.revision }],
  ['approval.revoke', { approvalId: one.approvalId }],
];

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A standing approval authority', () => {
  let w: RegistryWorld;
  /** Alpha's activation, version and approval ids each case sends from elsewhere. */
  const planted: string[] = [];

  beforeAll(async () => {
    w = await createRegistryWorld('c52aa');
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  /** Versions 1 and 2, an activation pinned to 1, then 1 and 2 adopted in turn: revision 3. */
  const adopted = async (): Promise<Adopted> => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const next = await w.release({ definitionId, modes: ['manual', 'scheduled'] });
    const second = String(detail(next)['versionId']);
    let approvalId = '';
    for (const [revision, at] of [
      [1, versionId],
      [2, second],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one adoption after the other
      const adopt = await w.as(w.admin, 'activation.adopt', {
        activationId,
        versionId: at,
        expectedRevision: revision,
      });
      expect(adopt.status, JSON.stringify(adopt.body)).toBe(200);
      approvalId = String(detail(adopt)['approvalId']);
    }
    planted.push(activationId, second, approvalId);
    return { activationId, second, approvalId, revision: 3 };
  };

  const approvalRows = async (business?: string): Promise<readonly number[]> => [
    ...(await w.changes(business)),
    await w.rows('standing_approvals', business),
    await w.rows('standing_approval_revocations', business),
  ];

  /** The admin's change, which must apply; its detail. */
  const applied = async (name: string, body: Record<string, unknown>) => {
    const answer = await w.as(w.admin, name, body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return detail(answer);
  };

  let hour = 0;
  const fires = async (activationId: string): Promise<number> => {
    const { db, business } = w.controls.fixture;
    const counting = await starter(db, business);
    await db.app.withBusiness(business, async (tx) => {
      const claim = await claimOccurrence(tx, activationId, {
        dueAt: new Date(Date.UTC(2026, 10, 3, (hour += 1))),
      });
      if (claim.kind === 'claimed')
        await dispatchOccurrence(tx, claim.occurrence.id, counting.start);
    });
    return counting.runs.length;
  };

  it('C52-A audit readback: each change is recorded by its person and joins the audit chain', async () => {
    const one = await adopted();
    const at = (expectedRevision: number) => ({ activationId: one.activationId, expectedRevision });
    const back = await applied('activation.roll_back', at(3));
    await applied('approval.revoke', { approvalId: String(back['approvalId']) });
    await applied('activation.turn_off', at(4));
    for (const command of C52A) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time
      const events = await w.controls.fixture.db.admin.execute<{ readonly hash: string }>(
        `select hash from public.audit_events
          where actor_id = $1 and command = $2 and outcome = 'applied'`,
        [w.admin.actorId, command],
      );
      expect(events.length, command).toBeGreaterThan(0);
      for (const event of events) expect(event.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
    // Each hash recomputed from its row, each linked to the one before, no gap.
    const chain = await w.controls.fixture.db.app.withBusiness(
      w.alpha,
      async (tx) => await verifyAuditChain(tx),
    );
    expect(chain.firstBreak).toBeUndefined();
    expect(chain.intact).toBe(true);
    const record = await w.controls.fixture.db.admin.execute<{
      readonly act: string;
      readonly decided: string;
      readonly revoked: string | null;
      readonly at: string | null;
    }>(
      `select s.act, s.decided_by_actor_id as decided, r.revoked_by_actor_id as revoked,
              r.revoked_at::text as at
         from public.standing_approvals s
         left join public.standing_approval_revocations r on r.approval_id = s.id
        where s.activation_id = $1 order by s.sequence`,
      [one.activationId],
    );
    expect(record.map((kept) => [kept.act, kept.decided, kept.revoked])).toStrictEqual([
      ['adopted', w.admin.actorId, null],
      ['adopted', w.admin.actorId, null],
      ['rolled_back', w.admin.actorId, w.admin.actorId],
    ]);
    expect(record[2]?.at).not.toBeNull();
    const [activation] = await w.controls.fixture.db.admin.execute<{ readonly by: string }>(
      'select changed_by_actor_id as by from public.activations where id = $1 and not enabled',
      [one.activationId],
    );
    expect(activation?.by).toBe(w.admin.actorId);
  });

  it('C52-A refusal automation:manage: read, client-scoped, settings-only and task-only holders change nothing', async () => {
    const one = await adopted();
    const before = await approvalRows();
    for (const who of [w.reader, w.clientManager, w.settingsOnly, w.plain]) {
      for (const [name, body] of bodies(one)) {
        // eslint-disable-next-line no-await-in-loop -- one caller and body at a time
        const answer = await w.as(who, name, body);
        expect([answer.status, answer.body['code']], `${who.actorId} ${name}`).toStrictEqual([
          403,
          'SCOPE_NOT_GRANTED',
        ]);
        expect(JSON.stringify(answer.body)).not.toContain(one.approvalId);
      }
    }
    expect(await approvalRows()).toStrictEqual(before);
    expect(await fires(one.activationId)).toBe(1);
  });

  it('C52-A agent refused: an agent under a live delegation adopts, rolls back, revokes and turns off nothing', async () => {
    const one = await adopted();
    const task = await w.controls.createTask('agent crossing');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const credential = String(picked['credential']);
    const before = await approvalRows();
    for (const [name, body] of bodies(one)) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.controls.asAgent(name, body, credential);
      w.answers.push(answer);
      // Outside every agent's reach (`agent: 'never'`), not merely outside this delegation's collections.
      expect([answer.status, answer.body['code'], answer.body['names']], name).toStrictEqual([
        403,
        'DELEGATION_EXCLUDES_OPERATION',
        [name],
      ]);
    }
    expect(await approvalRows()).toStrictEqual(before);
  });

  it('C52-A isolation: another business never adopts, rolls back, revokes or turns off these automations, and their ids answer as fabricated ones', async () => {
    const one = await adopted();
    const own = w.bravoRows;
    const theirs = await w.as(
      w.bravoAdmin,
      'activation.adopt',
      { activationId: own.activationId, versionId: own.versionId, expectedRevision: 1 },
      'bravo',
    );
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const bravoApproval = String(detail(theirs)['approvalId']);
    const ours = await approvalRows();
    const bravoBefore = await approvalRows('bravo');
    const fabricated: Adopted = {
      activationId: randomUUID(),
      second: randomUUID(),
      approvalId: randomUUID(),
      revision: one.revision,
    };
    const crossed = bodies(one);
    const made = bodies(fabricated);
    // Alpha's version aimed at bravo's own activation, against a fabricated version.
    const at = { activationId: own.activationId, expectedRevision: 2 };
    crossed.push(['activation.adopt', { ...at, versionId: one.second }]);
    made.push(['activation.adopt', { ...at, versionId: randomUUID() }]);
    for (const [index, [name, body]] of crossed.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const real = await w.as(w.bravoAdmin, name, body, 'bravo');
      // eslint-disable-next-line no-await-in-loop -- its fabricated twin
      const twin = await w.as(w.bravoAdmin, name, made[index]?.[1] ?? {}, 'bravo');
      expect(real.status, name).toBe(404);
      expect(seen(real), name).toStrictEqual(seen(twin));
    }
    expect(await approvalRows()).toStrictEqual(ours);
    expect(await approvalRows('bravo')).toStrictEqual(bravoBefore);
    expect(await fires(one.activationId)).toBe(1);
    const bravoView = JSON.stringify(await w.registry(w.bravoAdmin, 'bravo'));
    expect(bravoView).toContain(bravoApproval);
    expect(bravoView).not.toContain(one.approvalId);
    expect(bravoView).not.toContain(w.canary);
    expect(JSON.stringify(await w.registry(w.admin))).not.toContain(bravoApproval);
  });

  it('C52-A isolation: a holder at one client’s scope is refused every change and shown no approval', async () => {
    const one = await adopted();
    const before = await approvalRows();
    for (const [name, body] of bodies(one)) {
      // eslint-disable-next-line no-await-in-loop -- one change at a time
      const answer = await w.as(w.clientManager, name, body);
      expect([answer.status, answer.body['code']], name).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
      expect(JSON.stringify(answer.body)).not.toContain(one.approvalId);
    }
    const read = await w.as(w.clientManager, 'automation.registry', {});
    expect([read.status, read.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(await approvalRows()).toStrictEqual(before);
  });

  it('C52-A isolation: no answer to another business or a refused caller carries a canary or a sent id', () => {
    const foreign = w.answers.filter((answer) => answer.status !== 200);
    expect(foreign.length).toBeGreaterThan(0);
    expect(planted.length).toBeGreaterThan(0);
    for (const answer of foreign) {
      const body = JSON.stringify(answer.body);
      for (const marker of [w.canary, ...planted]) expect(body).not.toContain(marker);
    }
  });

  it('C52-A parity: adopt, roll back, turn off and revoke are automation:manage, person only', () => {
    for (const name of C52A) {
      expect(row(name), name).toStrictEqual(['write', 'automation', 'manage', 'never', 'business']);
    }
  });
});
