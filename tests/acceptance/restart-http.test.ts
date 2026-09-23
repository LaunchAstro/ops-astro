// SPDX-License-Identifier: AGPL-3.0-only
//
// W06 over HTTP, against a restarted API process on a restarted Postgres.
//
// `restart-and-expiry.test.ts` restarts the container and then drives the
// replays, the cancelled pickup and the handback through an in-process
// `createApi`. This file closes that gap: every call after the restart goes
// over the loopback socket to `apps/api/server.ts` running as a new process,
// started only after the old one exited and the container came back.
//
// The order is the claim. Everything is minted first (through the in-process
// app, which is only the fixture), then the API process is started, read,
// stopped; the container is restarted; the test waits, with nothing serving,
// until the short gate's expiry has passed; and only then is a new API
// process started. So the gate expires while the processes are down, and the
// Request Changes round is opened before the restart and continued after it.
//
// Asked only when both restarts are asked (`L5_RESTART_CONTAINER_NAME` and
// `L5_RESTART_API_PORT`), which `pnpm verify:restart` does. Otherwise every
// case is printed as skipped.
//
// `L5_RESTART_INDUCE_FAILURE` is for the removal proof only: `throw` fails
// the run with everything up; `crash` kills the runner there, so no `afterAll`
// runs and only `restart-proof.sh`'s exit trap removes what was left.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from './world.ts';
import {
  asAda,
  asAgent,
  countLeases,
  declaredContainer,
  identities,
  report,
  restartContainer,
  revisionOf,
  startedAt,
  walkTheJourney,
  walkTheOtherLineages,
  type Journey,
  type Lineages,
} from './restart-harness.ts';
import { declaredApiPort, overHttp, startApi, type RunningApi } from './restart-process.ts';

const asked =
  process.env['L5_RESTART_CONTAINER_NAME'] !== undefined &&
  process.env['L5_RESTART_API_PORT'] !== undefined;
const induced = process.env['L5_RESTART_INDUCE_FAILURE'];

/** Seconds the short gate lives: long enough to mint the rest, short enough to lapse while down. */
const SHORT_GATE_SECONDS = 25;

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

async function scalar(world: World, sql: string, parameters: readonly unknown[]): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly v: string }>(sql, [
    world.alpha,
    ...parameters,
  ]);
  return String(rows[0]?.v);
}

describe.skipIf(serverUrl === undefined || !asked)('W06 over HTTP after a real restart', () => {
  let world: World;
  let journey: Journey;
  let lineages: Lineages;
  let api: World['api'];
  let first: RunningApi | undefined;
  let second: RunningApi | undefined;
  let before: Record<string, readonly string[]>;
  let shortGate: { readonly gateId: string; readonly versionId: string };
  let round: { readonly lineageId: string; readonly taskId: string; readonly gateId: string };
  let approved: Journey;

  beforeAll(async () => {
    world = await createWorld('rsh');
    lineages = await walkTheOtherLineages(world);
    journey = await walkTheJourney(world);
    // Approved and never picked up: what a production cancel would act on.
    approved = await walkTheJourney(world, { pickup: false });

    // A Request Changes round begun before the restart: version 1 proposed,
    // then sent back. Version 2 is proposed only after the restart.
    const roundTask = await asAda(world, world.api, '/task/create', {
      operationId: randomUUID(),
      fields: { title: `a proposal sent back before a restart ${randomUUID()}` },
    });
    const roundTaskId = String(roundTask.body['recordId']);
    const v1 = await asAda(world, world.api, '/task/propose', {
      operationId: randomUUID(),
      recordId: roundTaskId,
      expectedRevision: await revisionOf(world, roundTaskId),
      purpose: 'draft_the_reply',
      maximumMinor: 2000,
      currency: 'AUD',
      payload: { instruction: 'first draft' },
      step: { kind: 'compose', payload: {} },
    });
    expect(v1.code, 'propose version 1').toBe('ok');
    const v1Detail = v1.body['detail'] as Record<string, string>;
    const sentBack = await asAda(world, world.api, '/task/decide', {
      operationId: randomUUID(),
      gateId: v1Detail['gateId'],
      versionId: v1Detail['versionId'],
      decision: 'request_changes',
      note: 'shorter, please',
    });
    expect(sentBack.code, 'request changes on version 1').toBe('ok');
    round = {
      lineageId: String(v1Detail['lineageId']),
      taskId: roundTaskId,
      gateId: String(v1Detail['gateId']),
    };

    // The short gate last, so its window starts as late as possible.
    const shortTask = await asAda(world, world.api, '/task/create', {
      operationId: randomUUID(),
      fields: { title: `a gate that lapses while nothing runs ${randomUUID()}` },
    });
    const shortTaskId = String(shortTask.body['recordId']);
    const short = await asAda(world, world.api, '/task/propose', {
      operationId: randomUUID(),
      recordId: shortTaskId,
      expectedRevision: await revisionOf(world, shortTaskId),
      purpose: 'draft_the_reply',
      maximumMinor: 500,
      currency: 'AUD',
      payload: { instruction: 'decide me before I lapse' },
      step: { kind: 'compose', payload: {} },
      expiresInSeconds: SHORT_GATE_SECONDS,
    });
    expect(short.code, 'propose the short gate').toBe('ok');
    const shortDetail = short.body['detail'] as Record<string, string>;
    shortGate = {
      gateId: String(shortDetail['gateId']),
      versionId: String(shortDetail['versionId']),
    };

    // The restart. The API process first, then the container under it.
    const port = declaredApiPort();
    const container = declaredContainer(serverUrl);
    first = await startApi(world, port);
    const live = await scalar(
      world,
      'select (expires_at > now())::text as v from public.gates where business_id = $1 and id = $2',
      [shortGate.gateId],
    );
    expect(live, 'the short gate is still open while the first process serves').toBe('true');
    await first.stop();
    const startedBefore = startedAt(container);
    restartContainer(container);
    const startedAfter = startedAt(container);
    expect(startedAfter).not.toBe(startedBefore);

    // Nothing serves now. Wait on the database's own clock until the gate
    // lapses. The pool's first queries after the restart meet connections the
    // server closed (EPIPE), so an error here is a retry, not an answer.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const lapsed = await scalar(
        world,
        'select (expires_at <= now())::text as v from public.gates where business_id = $1 and id = $2',
        [shortGate.gateId],
      ).catch(() => 'unreachable');
      if (lapsed === 'true') break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    before = await identities(world);
    second = await startApi(world, port);
    api = overHttp(port);
    report('http restart', [
      `container ${startedBefore} -> ${startedAfter}`,
      `pid ${String(first.pid)} -> ${String(second.pid)}`,
      `port ${port}`,
    ]);
    if (induced === 'throw') throw new Error('induced failure: the run stops with everything up');
    if (induced === 'crash') process.kill(process.pid, 'SIGKILL');
  }, 240_000);

  afterAll(async () => {
    await second?.stop();
    await world?.close();
  }, 60_000);

  it('serves every identity unchanged from a new process on a restarted server', async () => {
    expect(second?.pid).not.toBe(first?.pid);
    const read = await asAda(world, api, '/task/read', {
      operationId: randomUUID(),
      recordId: journey.taskId,
    });
    expect(read.code).toBe('ok');
    expect(await identities(world)).toStrictEqual(before);
  });

  it('answers byte-identical propose and decide replays over HTTP and adds no row', async () => {
    const proposeAgain = await asAda(world, api, '/task/propose', journey.proposeBody);
    const decideAgain = await asAda(world, api, '/task/decide', journey.decideBody);
    expect(proposeAgain.code, 'replayed propose').toBe('ok');
    expect(decideAgain.code, 'replayed decide').toBe('ok');
    expect(await identities(world)).toStrictEqual(before);
    report('http replays', [
      `propose ${String(proposeAgain.status)}`,
      `decide ${String(decideAgain.status)}`,
    ]);
  });

  it('refuses the cancelled lineage its pickup over HTTP and mints no hold', async () => {
    const leases = await countLeases(world, lineages.cancelledReservationId);
    const operationId = randomUUID();
    const resumed = await asAgent(world, api, '/task/pickup', {
      operationId,
      reservationId: lineages.cancelledReservationId,
    });
    expect(resumed.status).toBe(409);
    expect(resumed.code).toBe('RESERVATION_NOT_CLAIMABLE');
    expect(await countLeases(world, lineages.cancelledReservationId)).toBe(leases);
    // Every table as it was, except that the register may have recorded the
    // refused attempt under its own new operation id, and nothing else.
    const after = await identities(world);
    const { register: registerAfter, ...restAfter } = after;
    const { register: registerBefore, ...restBefore } = before;
    expect(restAfter).toStrictEqual(restBefore);
    const added = (registerAfter ?? []).filter((id) => !(registerBefore ?? []).includes(id));
    expect(added.every((id) => id === operationId)).toBe(true);
    expect(after['lineages']).toContain(`${lineages.cancelledLineageId}:cancelled`);
    report('http cancelled pickup', [
      `${String(resumed.status)} ${resumed.code}`,
      `register +${String(added.length)}`,
    ]);
  });

  it('hands back exactly once over HTTP, and a replayed pickup adds no hold', async () => {
    const leases = await countLeases(world, journey.reservationId);
    const receipts = (await identities(world))['receipts']?.length ?? 0;
    const replayed = await asAgent(world, api, '/task/pickup', {
      operationId: journey.pickupOperationId,
      reservationId: journey.reservationId,
    });
    expect(replayed.code, 'replayed pickup').toBe('ok');
    expect(await countLeases(world, journey.reservationId)).toBe(leases);
    const handback = {
      leaseId: journey.leaseId,
      fence: journey.fence,
      outcome: 'completed',
      report: { wrote: 'a draft after the restart' },
    };
    const once = await asAgent(
      world,
      api,
      '/task/handback',
      { operationId: randomUUID(), ...handback },
      journey.credential,
    );
    expect(once.code, 'the first handback').toBe('ok');
    const twice = await asAgent(
      world,
      api,
      '/task/handback',
      { operationId: randomUUID(), ...handback },
      journey.credential,
    );
    expect(twice.status, 'the second handback').toBe(401);
    expect(twice.code, 'the second handback').toBe('DELEGATION_NOT_LIVE');
    expect((await identities(world))['receipts']?.length ?? 0).toBe(receipts + 1);
    expect(await countLeases(world, journey.reservationId)).toBe(leases);
    report('http handback', [
      `first ${once.code}`,
      `second ${String(twice.status)} ${twice.code}`,
      `receipts ${String(receipts)} -> ${String(receipts + 1)}`,
    ]);
  });

  it('holds a gate that lapsed while nothing ran as expired, never decided or approved', async () => {
    const decided = await asAda(world, api, '/task/decide', {
      operationId: randomUUID(),
      gateId: shortGate.gateId,
      versionId: shortGate.versionId,
      decision: 'approve',
      note: 'too late',
    });
    expect(decided.status).toBe(410);
    expect(decided.code).toBe('GATE_EXPIRED');
    const state = await scalar(
      world,
      'select state as v from public.gates where business_id = $1 and id = $2',
      [shortGate.gateId],
    );
    expect(state).not.toBe('approved');
    const decisions = await scalar(
      world,
      'select count(*)::text as v from public.gate_decisions where business_id = $1 and gate_id = $2',
      [shortGate.gateId],
    );
    expect(decisions, 'decisions on the lapsed gate').toBe('0');
    const holds = await scalar(
      world,
      'select count(*)::text as v from public.reservations where business_id = $1 and version_id = $2',
      [shortGate.versionId],
    );
    expect(holds, 'holds on the lapsed version').toBe('0');
    report('http lapsed gate', [
      `${String(decided.status)} ${decided.code}`,
      `state ${state}`,
      `decisions ${decisions}`,
      `holds ${holds}`,
    ]);
  });

  it('continues a Request Changes round to version 2 after the restart, once', async () => {
    const versionsOf = async (): Promise<string> =>
      await scalar(
        world,
        "select string_agg(version::text, ',' order by version) as v from public.proposal_versions where business_id = $1 and lineage_id = $2",
        [round.lineageId],
      );
    expect(await versionsOf()).toBe('1');
    const gateState = await scalar(
      world,
      'select state as v from public.gates where business_id = $1 and id = $2',
      [round.gateId],
    );
    expect(gateState, 'the sent-back gate across the restart').toBe('changes_requested');
    const body = {
      operationId: randomUUID(),
      recordId: round.taskId,
      lineageId: round.lineageId,
      expectedRevision: await revisionOf(world, round.taskId),
      purpose: 'draft_the_reply',
      maximumMinor: 2000,
      currency: 'AUD',
      payload: { instruction: 'second, shorter draft' },
      step: { kind: 'compose', payload: {} },
    };
    const v2 = await asAda(world, api, '/task/propose', body);
    expect(v2.code, 'propose version 2 over HTTP').toBe('ok');
    expect(await versionsOf()).toBe('1,2');
    const again = await asAda(world, api, '/task/propose', body);
    expect(again.code, 'replayed version 2').toBe('ok');
    expect(await versionsOf(), 'no duplicate version').toBe('1,2');
    report('http request changes round', [
      `versions ${await versionsOf()}`,
      `v1 gate ${gateState}`,
    ]);
  });

  // W06's "cancelled lineage resumes silently" needs a lineage cancelled the
  // way a person cancels one. Ledger lines 37-38 make run cancellation and
  // authorised restart required capabilities through owning production
  // interfaces, and the coordinator's ruling is that `cancelAndClassify`
  // called from a fixture is not that. Neither operation has a route at this
  // head, so both cases are `it.fails`, asserted as the behaviour: each fails
  // today on the missing route and turns red on the day the route lands,
  // which is the signal to flip it to `it` and move the cancelled-lineage
  // fixture onto it. The names `task.cancel` and `task.restart` are this
  // proof's placeholder until L3-CONTROLS declares the real ones.
  it.fails('cancels an approved lineage through a production operation over HTTP', async () => {
    const lineageId = await scalar(
      world,
      'select lineage_id::text as v from public.proposal_versions where business_id = $1 and id = $2',
      [approved.versionId],
    );
    const cancelled = await asAda(world, api, '/task/cancel', {
      operationId: randomUUID(),
      recordId: approved.taskId,
      lineageId,
      reason: 'the person withdrew it',
    });
    report('http task.cancel', [`${String(cancelled.status)} ${cancelled.code}`]);
    // Status too: a missing route answers 404 in plain text, which `call` reads as no refusal.
    expect([cancelled.status, cancelled.code], 'task.cancel').toStrictEqual([200, 'ok']);
    expect((await identities(world))['lineages']).toContain(`${lineageId}:cancelled`);
    const pickup = await asAgent(world, api, '/task/pickup', {
      operationId: randomUUID(),
      reservationId: approved.reservationId,
    });
    expect(pickup.code).toBe('RESERVATION_NOT_CLAIMABLE');
  });

  it.fails('restarts a cancelled lineage as a new lineage over HTTP', async () => {
    const restarted = await asAda(world, api, '/task/restart', {
      operationId: randomUUID(),
      recordId: approved.taskId,
      lineageId: lineages.cancelledLineageId,
    });
    report('http task.restart', [`${String(restarted.status)} ${restarted.code}`]);
    expect([restarted.status, restarted.code], 'task.restart').toStrictEqual([200, 'ok']);
    const detail = restarted.body['detail'] as Record<string, string> | undefined;
    expect(detail?.['lineageId']).not.toBe(lineages.cancelledLineageId);
    expect((await identities(world))['lineages']).toContain(
      `${lineages.cancelledLineageId}:cancelled`,
    );
  });
});
