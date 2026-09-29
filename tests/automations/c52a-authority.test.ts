// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's authority cases through the real API route (U36, #484): the refusal
// for `automation:manage`, the agent refused, the audit readback, three
// isolation crossings (another business; a holder of every key at one client's
// scope, since activations carry no client; an agent under a live delegation)
// and the surface parity. The world is `registry-world.ts`; the command cases
// are in `c52a-commands.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const C52A = ['activation.adopt', 'activation.roll_back', 'activation.turn_off', 'approval.revoke'];

const row = (name: string): readonly unknown[] => {
  const one = COMMAND_SURFACE.find((command) => command.name === name);
  return [one?.kind, one?.collection, one?.action, one?.agent, one?.authorisedOn];
};

interface Adopted {
  readonly activationId: string;
  readonly second: string;
  readonly approvalId: string;
  readonly revision: number;
}

const bodies = (one: Adopted): readonly (readonly [string, Record<string, unknown>])[] => [
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

  beforeAll(async () => {
    w = await createRegistryWorld('c52aa');
  }, 120_000);

  afterAll(async () => {
    await w?.controls.drop();
  });

  /** Versions 1 and 2, an activation pinned to 1, then 2 adopted by the admin. */
  const adopted = async (): Promise<Adopted> => {
    const { definitionId, versionId } = await w.define(['manual', 'scheduled']);
    const on = await w.activate(versionId);
    const activationId = String(detail(on)['activationId']);
    const next = await w.release({ definitionId, modes: ['manual', 'scheduled'] });
    const second = String(detail(next)['versionId']);
    const adopt = await w.as(w.admin, 'activation.adopt', {
      activationId,
      versionId: second,
      expectedRevision: 1,
    });
    expect(adopt.status, JSON.stringify(adopt.body)).toBe(200);
    return { activationId, second, approvalId: String(detail(adopt)['approvalId']), revision: 2 };
  };

  const approvalRows = async (): Promise<readonly number[]> => [
    ...(await w.changes()),
    await w.rows('standing_approvals'),
    await w.rows('standing_approval_revocations'),
  ];

  it('C52-A audit readback: each change is recorded by its person and joins the audit chain', async () => {
    const one = await adopted();
    const back = await w.as(w.admin, 'activation.roll_back', {
      activationId: one.activationId,
      expectedRevision: 2,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const revoke = await w.as(w.admin, 'approval.revoke', {
      approvalId: String(detail(back)['approvalId']),
    });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    const off = await w.as(w.admin, 'activation.turn_off', {
      activationId: one.activationId,
      expectedRevision: 3,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
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
    const record = await w.controls.fixture.db.admin.execute<{
      readonly act: string;
      readonly decided: string;
      readonly revoked: string | null;
    }>(
      `select s.act, s.decided_by_actor_id as decided, r.revoked_by_actor_id as revoked
         from public.standing_approvals s
         left join public.standing_approval_revocations r on r.approval_id = s.id
        where s.activation_id = $1 order by s.sequence`,
      [one.activationId],
    );
    expect(record).toStrictEqual([
      { act: 'adopted', decided: w.admin.actorId, revoked: null },
      { act: 'rolled_back', decided: w.admin.actorId, revoked: w.admin.actorId },
    ]);
    const activation = await w.controls.fixture.db.admin.execute<{
      readonly enabled: boolean;
      readonly changed: string;
    }>('select enabled, changed_by_actor_id as changed from public.activations where id = $1', [
      one.activationId,
    ]);
    expect(activation).toStrictEqual([{ enabled: false, changed: w.admin.actorId }]);
  });

  it('C52-A refusal automation:manage: read, write, client-scoped and settings-only holders change nothing', async () => {
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
      }
    }
    expect(await approvalRows()).toStrictEqual(before);
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
      expect(answer.status, name).toBe(403);
      expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
    }
    expect(await approvalRows()).toStrictEqual(before);
  });

  it('C52-A isolation: another business never adopts, rolls back, revokes or turns off these automations', async () => {
    const one = await adopted();
    const before = await approvalRows();
    for (const [name, body] of bodies(one)) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await w.as(w.bravoAdmin, name, body, 'bravo');
      expect([answer.status, answer.body['code']], name).toStrictEqual([404, 'NOT_FOUND']);
    }
    expect(await approvalRows()).toStrictEqual(before);
    const theirs = await w.registry(w.bravoAdmin, 'bravo');
    expect(JSON.stringify(theirs)).not.toContain(one.approvalId);
    expect(JSON.stringify(theirs)).not.toContain(w.canary);
    const ours = await w.registry(w.admin);
    expect(JSON.stringify(ours)).not.toContain(w.bravoCanary);
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

  it('C52-A isolation: no answer to another business or a refused caller carries a canary', () => {
    const foreign = w.answers.filter((answer) => answer.status !== 200);
    expect(foreign.length).toBeGreaterThan(0);
    for (const answer of foreign) expect(JSON.stringify(answer.body)).not.toContain(w.canary);
  });

  it('C52-A parity: adopt, roll back, turn off and revoke are automation:manage, person only', () => {
    for (const name of C52A) {
      expect(row(name), name).toStrictEqual(['write', 'automation', 'manage', 'never', 'business']);
    }
  });
});
