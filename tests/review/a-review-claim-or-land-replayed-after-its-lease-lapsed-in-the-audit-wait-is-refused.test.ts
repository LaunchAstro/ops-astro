// SPDX-License-Identifier: AGPL-3.0-only
//
// A review claim or land is asked of its lease (`runtimeShaped: 'leaseId'`), so
// its stored success goes out again only while that lease is still the
// caller's, judged after the replay's last wait (#2332, `lease-replay.ts`).
// The first call applies. A fixture then holds the business's audit chain, so
// the replay's `replayed` audit insert waits on it; while it waits, the lease
// alone runs out (an agent's delegation stays live); then the fixture lets go.
// The replay is refused LEASE_EXPIRED and the `replayed` event is taken back,
// for a person working under their own lease and for an agent under its
// pickup, claim and land alike (#2339, #2353). A lapsed lease of business A
// never answers for the same body sent in business B.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import {
  advisoryLock,
  connect,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import {
  c35World,
  pickUpReviewed,
  underReview,
  type C35World,
  type Reviewed,
} from './c35-world.ts';
import { agentLogin, observationOf, pictureBytes } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35leasereplay');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

type Body = Readonly<Record<string, unknown>> & { readonly operationId: string };
/** One call of `body` on `database`, as the caller the case is about. */
type Caller = (database: Database, body: Body) => Promise<CommandResult>;

interface Worked {
  readonly reviewed: Reviewed;
  readonly leaseId: string;
  readonly fence: number;
  readonly call: Caller;
}

/** ava approves work on a new reviewed task and picks it up herself, under her own lease. */
async function underAvasLease(title: string): Promise<Worked> {
  const reviewed = await underReview(w, title);
  const [task] = await w.world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [w.world.business, reviewed.taskId],
  );
  const proposal = detailOf(
    await w.as(w.ava, {
      command: 'task.propose',
      recordId: reviewed.taskId,
      expectedRevision: Number(task?.revision),
      purpose: `person_replay_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'capture' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  const decided = detailOf(
    await w.as(w.ava, {
      command: 'task.decide',
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'ava captures the page herself',
    }),
  );
  const picked = detailOf(
    await w.as(w.ava, { command: 'task.pickup', reservationId: decided['reservationId'] }),
  );
  const call: Caller = async (database, body) =>
    await executeCommand(database, w.world.business, w.ava.presented, 'api', body as never);
  return { reviewed, leaseId: String(picked['leaseId']), fence: Number(picked['fence']), call };
}

/** The agent's pickup of a new reviewed task: it works under its delegation's lease. */
async function underTheAgentsLease(
  title: string,
): Promise<Worked & { readonly credential: string }> {
  const reviewed = await underReview(w, title);
  const lease = await pickUpReviewed(w, reviewed);
  const call: Caller = async (database, body) =>
    (await executeAgentCommand(
      database,
      w.world.business,
      agentLogin(w),
      lease.credential,
      body as never,
    )) as CommandResult;
  return {
    reviewed,
    leaseId: lease.leaseId,
    fence: lease.fence,
    call,
    credential: lease.credential,
  };
}

const claimOf = (worked: Worked): Body => ({
  command: 'review.capture_claim',
  operationId: randomUUID(),
  revisionId: worked.reviewed.revisionId,
  leaseId: worked.leaseId,
  fence: worked.fence,
});

const landOf = (worked: Worked): Body => ({
  command: 'review.capture_land',
  operationId: randomUUID(),
  revisionId: worked.reviewed.revisionId,
  leaseId: worked.leaseId,
  fence: worked.fence,
  width: 1480,
  picture: pictureBytes(6).toString('base64'),
  observation: observationOf(1480),
});

/** The operation `kind` names, applied once under the lease: a land is claimed first. */
async function appliedOnce(worked: Worked, kind: 'claim' | 'land'): Promise<Body> {
  const claim = claimOf(worked);
  expect(codeOf(await worked.call(w.world.db.app, claim)), 'the claim applies').toBe(
    'not-a-refusal',
  );
  if (kind === 'claim') return claim;
  const land = landOf(worked);
  expect(codeOf(await worked.call(w.world.db.app, land)), 'the land applies').toBe('not-a-refusal');
  return land;
}

/** Waits until the database's clock is past the lease's expiry. */
async function pastExpiry(leaseId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await w.world.db.admin.execute<{ readonly past: boolean }>(
      'select expires_at < clock_timestamp() as past from public.leases where id = $1',
      [leaseId],
    );
    if (row?.past === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`lease ${leaseId} never expired`);
}

/**
 * `body` replayed on its own connection while the business's audit chain is held. With
 * `lapse`, the lease alone is cut to two seconds first and the hold lasts past its end.
 */
async function replayedOnTheHeldChain(
  worked: Worked,
  body: Body,
  lapse: boolean,
): Promise<CommandResult> {
  if (lapse) {
    await w.world.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() + interval '2 seconds'
        where business_id = $1 and id = $2`,
      [w.world.business, worked.leaseId],
    );
  }
  const replayer = connect(w.world.db.appUrl);
  try {
    const chain = await hold(w.world.db.appUrl, w.world.business, async (tx) => {
      await advisoryLock(tx, tx.businessId.toLowerCase());
    });
    let replaying: Promise<CommandResult> | undefined;
    try {
      replaying = worked.call(replayer, body);
      await waitingOn(w.world.db.admin, 'advisory', 'audit_events');
      if (lapse) await pastExpiry(worked.leaseId);
    } finally {
      await chain.letGo();
    }
    return await replaying;
  } finally {
    await replayer.close();
  }
}

const refusedOnReplay = { answer: 'LEASE_EXPIRED', audit: ['applied:', 'refused:LEASE_EXPIRED'] };

/** The answer's code and the operation's audit events in order. */
async function seen(
  answer: CommandResult,
  body: Body,
): Promise<{ readonly answer: string; readonly audit: readonly string[] }> {
  const audit = (await w.world.auditFor(body.operationId)).map(
    ({ outcome, code }) => `${outcome}:${code ?? ''}`,
  );
  return { answer: codeOf(answer), audit };
}

/**
 * With the lease of business A lapsed, `body` (its operation id included) sent in business B by
 * eve, B's own member, and by the agent under A's credential: whether either applied, whether
 * an answer names A's task, review or revision, what B's chain kept beyond a refusal, and A's
 * audit of the operation.
 */
async function sentInBAfterTheLapse(
  worked: Worked & { readonly credential: string },
  body: Body,
): Promise<unknown> {
  await w.world.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second'
      where business_id = $1 and id = $2`,
    [w.world.business, worked.leaseId],
  );
  const inB = [
    await executeCommand(w.world.db.app, w.beta, w.eve.presented, 'api', body as never),
    (await executeAgentCommand(
      w.world.db.app,
      w.beta,
      agentLogin(w),
      worked.credential,
      body as never,
    )) as CommandResult,
  ];
  const foreign = [worked.reviewed.taskId, worked.reviewed.reviewId, worked.reviewed.revisionId];
  const releasedInB = (
    await w.world.db.admin.execute<{ readonly outcome: string }>(
      `select outcome from public.audit_events
        where business_id = $1 and operation_id = $2 and outcome <> 'refused'`,
      [w.beta, body.operationId],
    )
  ).map(({ outcome }) => outcome);
  return {
    applied: inB.map((answer) => codeOf(answer) === 'not-a-refusal'),
    leaked: inB.some((answer) => foreign.some((id) => JSON.stringify(answer).includes(id))),
    releasedInB,
    auditInA: await w.world.auditFor(body.operationId),
  };
}

describe.skipIf(serverUrl === undefined)('a review replay after its lease lapsed', () => {
  it.each(['claim', 'land'] as const)(
    "a person's %s replayed after their own lease lapsed in the audit wait is refused",
    async (kind) => {
      const worked = await underAvasLease(`Person ${kind} replayed past its lease`);
      const body = await appliedOnce(worked, kind);
      const answer = await replayedOnTheHeldChain(worked, body, true);
      expect(await seen(answer, body)).toStrictEqual(refusedOnReplay);
    },
    60_000,
  );

  it.each(['claim', 'land'] as const)(
    "an agent's %s replayed after its lease alone lapsed in the audit wait is refused",
    async (kind) => {
      const worked = await underTheAgentsLease(`Agent ${kind} replayed past its lease`);
      const body = await appliedOnce(worked, kind);
      const answer = await replayedOnTheHeldChain(worked, body, true);
      expect(await seen(answer, body)).toStrictEqual(refusedOnReplay);
    },
    60_000,
  );

  it("an agent's land replayed while its lease is live returns the stored success", async () => {
    const worked = await underTheAgentsLease('Agent land replayed under a live lease');
    const body = await appliedOnce(worked, 'land');
    const answer = await replayedOnTheHeldChain(worked, body, false);
    expect(await seen(answer, body)).toStrictEqual({
      answer: 'not-a-refusal',
      audit: ['applied:', 'replayed:'],
    });
  }, 60_000);

  it('a lapsed lease of business A answers no replay of the claim sent in business B', async () => {
    const worked = await underTheAgentsLease('Claim of A sent again in B');
    const body = await appliedOnce(worked, 'claim');
    const auditInA = await w.world.auditFor(body.operationId);
    expect(await sentInBAfterTheLapse(worked, body)).toStrictEqual({
      applied: [false, false],
      leaked: false,
      releasedInB: [],
      auditInA,
    });
  }, 60_000);
});
