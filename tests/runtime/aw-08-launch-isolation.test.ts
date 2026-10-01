// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 isolation and races on the launch gate and its reviewed-output mark.
// Three real crossings, each beside a positive control: another business's
// launched lease and mark; another client's work in the same business; and
// another person's work, reached under a live delegation of the same agent.
// Each refusal marks nothing, changes no mark and carries no foreign id. The
// mark itself only names its own lineage. Transactions at once: two dispatches
// of a plan's lease are both refused; behind a grant change in flight that
// rolls back, a plan's dispatch is refused and a launch's applies.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isReviewedOutput, markReviewedOutput } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { noDatabase, useAw04World, w } from './aw-04-world.ts';
import {
  dispatchBody,
  handBack,
  launched,
  marked,
  marksOf,
  proposeEffect,
  type Approver,
  type Launched,
} from './aw-08-world.ts';
import {
  appliedDetail,
  approve,
  approveBody,
  asAgent,
  awaitParked,
  barrier,
  codeOf,
  createTask,
  pickup,
  proposeBody,
  racer,
  revisionOf,
  rows,
  seedSchedules,
  settle,
  type Body,
  type Schedules,
} from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw08_launch_iso');

/** A third business for the races, whose grants they revoke. */
let racing: Schedules;
beforeAll(async () => {
  if (noDatabase) return;
  racing = await seedSchedules(w.alpha.db, 'aw08-race', 1_000_000);
}, 180_000);

const as = (s: Schedules, member: Member, body: Body) =>
  executeCommand(s.db.app, s.business, member.presented, 'api', body as never);

const approverOf =
  (s: Schedules, member: Member): Approver =>
  async (proposal) =>
    appliedDetail(await as(s, member, approveBody(proposal)), 'task.decide');

function carriesNothingOf(result: unknown, work: Launched): void {
  const body = JSON.stringify(result);
  for (const foreign of [
    work.taskId,
    String(work.picked['leaseId']),
    String(work.handedBack['successorVersionId']),
    String(work.handedBack['successorGateId']),
  ]) {
    expect(body).not.toContain(foreign);
  }
}

const dispatchAs = async (
  s: Schedules,
  lease: Launched['picked'],
  credential: Launched['picked'],
) => await asAgent(s, dispatchBody(lease), String(credential['credential']));

/** The live delegation behind a lease, read as the owner. */
async function delegationLive(s: Schedules, leaseId: unknown): Promise<boolean> {
  const found = await rows<{ live: boolean }>(
    s,
    `select (d.revoked_at is null and d.settled_at is null and d.expires_at > now()) as live
       from public.leases l join public.delegations d
         on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [s.business, leaseId],
  );
  return found[0]?.live === true;
}

it("AW-08 isolation: another business's lease and mark are neither dispatched, read nor written", async () => {
  const theirs = await launched(w.alpha, 'aw08 iso alpha');
  const ours = await launched(w.bravo, 'aw08 iso bravo');
  expect(await delegationLive(w.bravo, ours.picked['leaseId'])).toBe(true);

  const crossed = await dispatchAs(w.bravo, theirs.picked, ours.picked);
  expect(codeOf(crossed)).toBe('LEASE_NOT_OWNED');
  carriesNothingOf(crossed, theirs);
  expect(await marked(w.alpha, theirs.taskId)).toBe(0);

  const version = String(theirs.handedBack['successorVersionId']);
  await w.bravo.db.app.withBusiness(w.bravo.business, async (tx) => {
    expect(await isReviewedOutput(tx, version)).toBe(false);
  });
  await expect(
    w.bravo.db.app.withBusiness(w.bravo.business, async (tx) => {
      await markReviewedOutput(tx, {
        versionId: String(theirs.plan['versionId']),
        lineageId: String(theirs.plan['lineageId']),
        leaseId: String(ours.picked['leaseId']),
      });
    }),
  ).rejects.toThrow();
  expect(await marksOf(w.alpha, theirs.taskId)).toEqual([version]);

  // Control: each business dispatches its own launch.
  appliedDetail(await dispatchAs(w.alpha, theirs.picked, theirs.picked), 'dispatch');
  appliedDetail(await dispatchAs(w.bravo, ours.picked, ours.picked), 'dispatch');
  expect(await marked(w.alpha, theirs.taskId)).toBe(1);
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    expect(await isReviewedOutput(tx, version)).toBe(true);
  });
});

it("AW-08 isolation: another client in the same business never launches, nor marks, the other client's work", async () => {
  const s = w.alpha;
  const other = await proposeEffect(s, 'aw08 iso other client');
  const otherWork = await pickup(s, (await approve(s, other.plan))['reservationId']);
  const otherHanded = await handBack(s, otherWork);

  const ownTask = await createTask(s, `aw08 iso own client ${randomUUID()}`);
  const client = await enrol(s.db.app, s.business, `aw08-client-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, client, action, { kind: 'record', id: ownTask });
    }
  });

  const launch = await as(
    s,
    client,
    approveBody({
      gateId: otherHanded['successorGateId'],
      versionId: otherHanded['successorVersionId'],
    }),
  );
  expect(codeOf(launch)).toBe('SCOPE_NOT_GRANTED');
  expect(JSON.stringify(launch)).not.toContain(other.taskId);
  const gate = await rows<{ state: string }>(s, `select state from public.gates where id = $1`, [
    otherHanded['successorGateId'],
  ]);
  expect(gate).toEqual([{ state: 'pending' }]);

  // Control: the client accepts the plan on its own task.
  const ownPlan = appliedDetail(
    await as(s, client, {
      ...proposeBody(ownTask, await revisionOf(s, ownTask), { purpose: `own_${Date.now()}` }),
      step: { kind: 'synthetic_comment', payload: {} },
    }),
    'task.propose',
  );
  expect((await approverOf(s, client)(ownPlan))['decision']).toBe('approve');

  // A mark names its own subject: the other client's lease marks no version of this
  // client's lineage, and no version of its own lineage under this lineage's name.
  for (const mark of [
    { versionId: ownPlan['versionId'], lineageId: other.plan['lineageId'] },
    { versionId: other.plan['versionId'], lineageId: ownPlan['lineageId'] },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await expect(
      s.db.app.withBusiness(s.business, async (tx) => {
        await markReviewedOutput(tx, {
          versionId: String(mark.versionId),
          lineageId: String(mark.lineageId),
          leaseId: String(otherWork['leaseId']),
        });
      }),
    ).rejects.toThrow(/named lineage/u);
  }
  await s.db.app.withBusiness(s.business, async (tx) => {
    expect(await isReviewedOutput(tx, String(ownPlan['versionId']))).toBe(false);
  });
  expect(await marksOf(s, ownTask)).toEqual([]);
  expect(await marksOf(s, other.taskId)).toEqual([otherHanded['successorVersionId']]);
});

it("AW-08 isolation: another person's launched work is not reached under the agent's live delegation for this one", async () => {
  const s = w.alpha;
  const person = await enrol(s.db.app, s.business, `aw08-person-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, person, action, undefined, true);
    }
  });
  const theirs = await launched(s, 'aw08 iso decider');
  const mine = await launched(s, 'aw08 iso person', approverOf(s, person));
  expect(await delegationLive(s, mine.picked['leaseId'])).toBe(true);

  const crossed = await dispatchAs(s, theirs.picked, mine.picked);
  expect(codeOf(crossed)).toBe('DELEGATION_OUT_OF_PURPOSE');
  carriesNothingOf(crossed, theirs);
  expect(await marked(s, theirs.taskId)).toBe(0);

  // Control: each person's launch dispatches under its own delegation.
  appliedDetail(await dispatchAs(s, mine.picked, mine.picked), 'dispatch');
  appliedDetail(await dispatchAs(s, theirs.picked, theirs.picked), 'dispatch');
  expect([await marked(s, mine.taskId), await marked(s, theirs.taskId)]).toEqual([1, 1]);
});

it("AW-08 race: two dispatches of a plan's lease at once on two backends are both refused, and mark nothing", async () => {
  // Under the plan's accept only: a gate that let either through would mark the step.
  const plan = await proposeEffect(racing, 'aw08 race plan twice');
  const picked = await pickup(racing, (await approve(racing, plan.plan))['reservationId']);
  const work = { taskId: plan.taskId, picked };
  const [a, b] = [racer(racing), racer(racing)];
  try {
    const answers = await settle(
      [a, b].map(
        async (database) =>
          await asAgent(
            racing,
            dispatchBody(work.picked),
            String(work.picked['credential']),
            database,
          ),
      ),
    );
    const codes = answers.map((one) => (one.status === 'fulfilled' ? codeOf(one.value) : 'threw'));
    expect(codes).toEqual(['LAUNCH_NOT_DECIDED', 'LAUNCH_NOT_DECIDED']);
    expect(await marked(racing, work.taskId)).toBe(0);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

// A grant change in flight holds a plan's dispatch and a launch's; it rolls
// back, and the gate decides under the lock each waited on: the plan's lease is
// refused and the launch dispatches. With no gate both would mark their step.
// A revocation that commits refuses a launch AUTHORITY_LOST
// (`recheck_inside_dispatch`, t2c1-dispatch).
it("AW-08 race: behind a grant change in flight, a plan's dispatch is refused LAUNCH_NOT_DECIDED and the launch's applies", async () => {
  const work = await launched(racing, 'aw08 race launch');
  const plan = await proposeEffect(racing, 'aw08 race plan');
  const working = await pickup(racing, (await approve(racing, plan.plan))['reservationId']);
  const [revoker, a, b] = [racer(racing), racer(racing), racer(racing)];
  const held = barrier();
  const locked = barrier();
  const rolledBack = new Error('the grant change rolls back');
  const revoking = revoker
    .withBusiness(racing.business, async (tx) => {
      await tx.query(
        `update public.grants set revoked_at = now()
          where business_id = $1 and subject_id = $2 and action = 'write'`,
        [racing.business, racing.decider.personId],
      );
      locked.release();
      await held.held;
      throw rolledBack;
    })
    .catch((error: unknown) => {
      if (error !== rolledBack) throw error;
    });
  const release = held.release;
  try {
    await locked.held;
    // Each on a backend of its own, so both wait on the grant row at once.
    const both = [
      asAgent(racing, dispatchBody(working), String(working['credential']), a),
      asAgent(racing, dispatchBody(work.picked), String(work.picked['credential']), b),
    ];
    await awaitParked(racing, 'grants', 2);
    release();
    await revoking;
    expect((await Promise.all(both)).map((one) => codeOf(one))).toEqual([
      'LAUNCH_NOT_DECIDED',
      'applied',
    ]);
    expect([await marked(racing, plan.taskId), await marked(racing, work.taskId)]).toEqual([0, 1]);
  } finally {
    release();
    await Promise.all([revoker.close(), a.close(), b.close()]);
  }
});
