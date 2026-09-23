// SPDX-License-Identifier: AGPL-3.0-only
//
// Root ruling R-B: authority loss still revokes the delegation and classifies
// its holds in one transaction, and the agent that presents its own still
// unexpired credential afterwards is told `DELEGATION_NARROWED` (minimum
// contract 8.2 case 6, ledger I08), from a cause the revoking transaction
// recorded (`delegations.revocation_cause`, 0023).
//
// Everything goes through the real command entry: a real agent lease and
// credential, `grant.revoke` by the grant manager, then heartbeat and
// handback. The controls: an alternate live write grant keeps the work;
// explicit `delegation.revoke`, cancellation and expiry keep
// `DELEGATION_NOT_LIVE`; another agent, an unknown token, another business and
// a bare call learn nothing about the loss; the cause survives a retry and a
// rebuilt API. The admin connection only reads, except where a case moves time.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../apps/api/app.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { ADMIN_ACTIONS, ADMIN_COLLECTIONS, enrolAgent, enrolCaller } from '../acceptance/cast.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  rebuildApi,
  serverUrl,
  type AgentIdentity,
  type Caller,
} from '../acceptance/world.ts';
import { createIdentWorld, type IdentWorld, type Picked } from '../acceptance/ident-audit-cases.ts';

const NARROWED = 'DELEGATION_NARROWED';
const NOT_LIVE = 'DELEGATION_NOT_LIVE';

interface Work {
  readonly approver: Caller;
  readonly agent: AgentIdentity;
  readonly picked: Picked;
}

/** Nothing in a refusal names the credential, the delegation, the person or the grant. */
const discloses = (text: string, x: Work, grantIds: readonly string[] = []): readonly string[] =>
  [x.picked.credential, x.picked.delegationId, x.approver.personId ?? '', ...grantIds].filter(
    (secret) => secret !== '' && text.includes(secret),
  );

describe.skipIf(serverUrl === undefined)('R-B: authority loss answers DELEGATION_NARROWED', () => {
  let w: IdentWorld;

  beforeAll(async () => {
    w = await createIdentWorld('narrowed');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const admin = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<readonly T[]> => await w.h.world.db.admin.execute<T>(sql, [...parameters]);

  const one = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<T> => {
    const row = (await admin<T>(sql, parameters))[0];
    if (row === undefined) throw new Error(`no row for ${sql}`);
    return row;
  };

  /** A person who approves their own work, and an agent that picks it up. */
  async function work(name: string): Promise<Work> {
    const { world } = w.h;
    const approver = await enrolCaller(world.db, world.alpha, 'alpha', name, {
      membership: true,
      actions: ADMIN_ACTIONS,
      collections: ADMIN_COLLECTIONS,
    });
    const agent = await enrolAgent(world.db, world.alpha, world.ada.actorId as string);
    const made = await w.person(approver, 'task.create', { fields: { title: `work ${name}` } });
    const proposed = await w.person(approver, 'task.propose', {
      recordId: made.body['recordId'],
      expectedRevision: made.body['revision'],
      ...PROPOSAL,
    });
    const gate = proposed.body['detail'] as Record<string, unknown>;
    const decided = await w.person(approver, 'task.decide', {
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved for the R-B proof',
    });
    const reservationId = String(
      (decided.body['detail'] as Record<string, unknown>)['reservationId'],
    );
    const answer = await w.agent(agent, 'task.pickup', { reservationId });
    expect(answer.code, answer.text).toBe('ok');
    const detail = answer.body['detail'] as Record<string, unknown>;
    const picked: Picked = {
      taskId: String(detail['taskId']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      delegationId: String(detail['delegationId']),
      credential: String(detail['credential']),
      reservationId,
    };
    return { approver, agent, picked };
  }

  /** Revoke every live task write the approver holds, through `grant.revoke`. */
  async function revokeWrites(approver: Caller): Promise<readonly string[]> {
    const grants = await admin<{ id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [w.h.world.alpha, approver.personId],
    );
    expect(grants.length).toBeGreaterThan(0);
    const classified: string[] = [];
    for (const grant of grants) {
      // eslint-disable-next-line no-await-in-loop -- through the owning route, one at a time
      const revoked = await w.person(w.h.world.ada, 'grant.revoke', { grantId: grant.id });
      expect(revoked.code, revoked.text).toBe('ok');
      const detail = revoked.body['detail'] as Record<string, unknown>;
      classified.push(...(detail['classifiedHolds'] as string[]));
    }
    return classified;
  }

  const heartbeat = (x: Work, credential = x.picked.credential): ReturnType<IdentWorld['agent']> =>
    w.agent(
      x.agent,
      'task.heartbeat',
      { leaseId: x.picked.leaseId, fence: x.picked.fence },
      credential,
    );
  const handback = (x: Work, credential = x.picked.credential): ReturnType<IdentWorld['agent']> =>
    w.agent(
      x.agent,
      'task.handback',
      {
        leaseId: x.picked.leaseId,
        fence: x.picked.fence,
        outcome: 'completed',
        report: { wrote: 'after the loss' },
      },
      credential,
    );

  /** Everything a refusal must not change, and the cause recorded. */
  const state = async (x: Work): Promise<Record<string, unknown>> =>
    await one(
      `select l.state as lease, l.expires_at::text as lease_expiry, l.fence::text as fence,
              res.state as hold, res.classified_cause as hold_cause,
              res.classified_cause_id::text as hold_cause_id,
              d.revoked_at is not null as revoked, d.settled_at is not null as settled,
              d.revocation_cause as cause,
              (select count(*) from public.handback_reports hr
                where hr.business_id = l.business_id and hr.lease_id = l.id)::int as reports
         from public.leases l
         join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.id = $1`,
      [x.picked.leaseId],
    );

  it('grant loss closes the work once, then heartbeat and handback answer DELEGATION_NARROWED', async () => {
    const x = await work('narrowed_main');
    expect((await heartbeat(x)).code, 'control: the live grant admits the agent').toBe('ok');
    const grants = await admin<{ id: string }>(
      `select id from public.grants
        where business_id = $1 and subject_id = $2 and collection = 'task' and action = 'write'`,
      [w.h.world.alpha, x.approver.personId],
    );

    const classified = await revokeWrites(x.approver);
    expect(classified.filter((id) => id === x.picked.reservationId)).toHaveLength(1);
    const closed = await state(x);
    expect(closed).toMatchObject({
      lease: 'released',
      hold: 'abandoned',
      hold_cause: 'authority_revoked',
      hold_cause_id: x.picked.delegationId,
      revoked: true,
      settled: false,
      cause: 'authority_lost',
      reports: 0,
    });

    // Heartbeat retains nothing. The handback carries a supported report, and
    // T4 line 76 keeps it: exactly one unaccepted row naming the refusal, the
    // answer and R-B's cause unchanged (ROOT-NARROWED-REPORT-RULING).
    for (const [send, reports] of [
      [heartbeat, 0],
      [handback, 1],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one after the other, each against the same state
      const answer = await send(x);
      expect(answer.code, answer.text).toBe(NARROWED);
      expect(
        discloses(
          answer.text,
          x,
          grants.map((g) => g.id),
        ),
      ).toStrictEqual([]);
      // eslint-disable-next-line no-await-in-loop
      expect(await state(x), 'no effect: nothing reactivated, renewed or settled').toStrictEqual({
        ...closed,
        reports,
      });
    }
    const kept = await admin<{ disposition: string; refusal_code: string }>(
      `select disposition, refusal_code from public.handback_reports where lease_id = $1`,
      [x.picked.leaseId],
    );
    expect(kept.map((row) => [row.disposition, row.refusal_code])).toStrictEqual([
      ['retained', NARROWED],
    ]);
    const retained = { ...closed, reports: 1 };

    // A retry, of the call and of the revocation, answers the same bytes and
    // leaves the recorded cause as it was.
    const first = await heartbeat(x);
    expect((await heartbeat(x)).text).toBe(first.text);
    const again = await w.person(w.h.world.ada, 'grant.revoke', { grantId: grants[0]?.id });
    expect(again.code).toBe('TRANSITION_NOT_PERMITTED');
    expect(await state(x)).toStrictEqual(retained);

    // A rebuilt API holds nothing in memory from the first: the cause is the row's.
    const rebuilt = rebuildApi(w.h.world);
    try {
      const response = await rebuilt.api.fetch(
        new Request(`http://api.test${agentPath('alpha', '/task/heartbeat')}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...bearer(x.agent.token),
            [DELEGATION_HEADER]: x.picked.credential,
          },
          body: JSON.stringify({
            operationId: randomUUID(),
            leaseId: x.picked.leaseId,
            fence: x.picked.fence,
          }),
        }),
      );
      expect(await response.text()).toBe(first.text);
    } finally {
      await rebuilt.close();
    }
    expect(await state(x)).toStrictEqual(retained);
  }, 120_000);

  it('another agent, an unknown token, another business and a bare call learn nothing of the loss', async () => {
    const x = await work('narrowed_others');
    await revokeWrites(x.approver);
    const stranger = await enrolAgent(
      w.h.world.db,
      w.h.world.alpha,
      w.h.world.ada.actorId as string,
    );
    const answers = {
      stranger: await w.agent(
        stranger,
        'task.heartbeat',
        { leaseId: x.picked.leaseId, fence: x.picked.fence },
        x.picked.credential,
      ),
      unknown: await heartbeat(x, `${x.picked.credential.slice(0, -4)}0000`),
      bravo: await w.agent(
        x.agent,
        'task.heartbeat',
        { leaseId: x.picked.leaseId, fence: x.picked.fence },
        x.picked.credential,
        'bravo',
      ),
      bare: await w.agent(x.agent, 'task.heartbeat', {
        leaseId: x.picked.leaseId,
        fence: x.picked.fence,
      }),
    };
    expect(answers.stranger.code, answers.stranger.text).toBe(NOT_LIVE);
    expect(answers.unknown.text, 'unknown token and another agent alike').toBe(
      answers.stranger.text,
    );
    expect(answers.bravo.code).not.toBe(NARROWED);
    expect(answers.bare.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    for (const [label, answer] of Object.entries(answers)) {
      expect(answer.text, label).not.toMatch(/NARROWED|removed|narrowed|authority_lost/u);
      expect(discloses(answer.text, x), label).toStrictEqual([]);
    }
    expect((await state(x))['cause']).toBe('authority_lost');
  }, 120_000);

  it('an alternate live write grant keeps the work, and nothing is recorded', async () => {
    const x = await work('narrowed_alternate');
    await w.h.world.db.app.withBusiness(w.h.world.alpha, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: x.approver.personId as string },
        scope: { kind: 'record', id: x.picked.taskId },
        collection: 'task',
        action: 'write',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: x.approver.actorId as string,
      });
      expect(issued.ok).toBe(true);
    });
    const business = await admin<{ id: string }>(
      `select id from public.grants where business_id = $1 and subject_id = $2
          and action = 'write' and scope_kind = 'business' and revoked_at is null`,
      [w.h.world.alpha, x.approver.personId],
    );
    for (const grant of business) {
      // eslint-disable-next-line no-await-in-loop
      expect((await w.person(w.h.world.ada, 'grant.revoke', { grantId: grant.id })).code).toBe(
        'ok',
      );
    }
    expect(await state(x)).toMatchObject({
      lease: 'live',
      hold: 'held',
      revoked: false,
      cause: null,
    });
    expect((await heartbeat(x)).code).toBe('ok');
  }, 120_000);

  it('explicit delegation.revoke, cancellation and expiry keep DELEGATION_NOT_LIVE', async () => {
    const revoked = await work('narrowed_explicit');
    expect(
      (
        await w.person(w.h.world.ada, 'delegation.revoke', {
          delegationId: revoked.picked.delegationId,
        })
      ).code,
    ).toBe('ok');

    const cancelled = await work('narrowed_cancel');
    const lineage = await one<{ id: string }>(
      `select run.lineage_id::text as id from public.leases l
         join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
        where l.id = $1`,
      [cancelled.picked.leaseId],
    );
    const cancel = await w.person(cancelled.approver, 'task.cancel', {
      recordId: cancelled.picked.taskId,
      lineageId: lineage.id,
      reason: 'the client withdrew',
    });
    expect(cancel.code, cancel.text).toBe('ok');

    // Expiry after an authority loss: settled and expired come first, so the
    // recorded cause is not reached.
    const expired = await work('narrowed_expired');
    await revokeWrites(expired.approver);
    await admin(
      `update public.delegations
          set granted_at = now() - interval '3 seconds', expires_at = now() - interval '1 second'
        where id = $1`,
      [expired.picked.delegationId],
    );

    const causes = {
      revoked: 'delegation_revoked',
      cancelled: 'work_retired',
      expired: 'authority_lost',
    };
    for (const [label, x] of Object.entries({ revoked, cancelled, expired })) {
      // eslint-disable-next-line no-await-in-loop
      expect((await state(x))['cause'], label).toBe(causes[label as keyof typeof causes]);
      for (const send of [heartbeat, handback]) {
        // eslint-disable-next-line no-await-in-loop
        const answer = await send(x);
        expect(answer.code, `${label}: ${answer.text}`).toBe(NOT_LIVE);
        expect(answer.text, label).not.toMatch(/removed|narrowed/u);
      }
    }
  }, 180_000);

  it('a recorded cause is fixed', async () => {
    const x = await work('narrowed_fixed');
    await revokeWrites(x.approver);
    await expect(
      admin(`update public.delegations set revocation_cause = 'delegation_revoked' where id = $1`, [
        x.picked.delegationId,
      ]),
    ).rejects.toThrow(/revocation cause is fixed/u);
    expect((await state(x))['cause']).toBe('authority_lost');
  }, 120_000);
});
