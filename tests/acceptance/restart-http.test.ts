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
  agentOnLease,
  asAda,
  asAgent,
  countLeases,
  holdState,
  leaseState,
  recordHistoricalRejection,
  revokeWritesOf,
  walkAgentWork,
  declaredContainer,
  identities,
  report,
  restartContainer,
  revisionOf,
  startedAt,
  walkTheJourney,
  walkTheOtherLineages,
  type AgentWork,
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
  /** Version 2 of the sent-back round, proposed after the restart. */
  let roundV2: { readonly gateId: string; readonly versionId: string } | undefined;
  let shortTaskId: string;
  /** W06 (a): every identity, read after the historical fixture and before `restartContainer`. */
  let preRestart: Record<string, readonly string[]>;
  /** W04: approved, never picked up, never cancelled. */
  let unleased: Journey;
  let unleasedBefore: string;
  /** Recovery: the historical rejection's hold, and the lineage that names it. */
  let historical: Journey;
  let historicalLineageId: string;
  let historicalBefore: string;
  let historicalAttempts: readonly string[];
  /** I08: a live lease whose person lost their only write grant, and the explicit-revoke control. */
  let narrowed: AgentWork;
  let explicit: AgentWork;
  let narrowedBefore: string;
  let explicitBefore: string;

  /**
   * A snapshot as the restarted process must leave it: the one historical
   * hold classified by startup recovery, and nothing else moved.
   */
  const recovered = (
    snapshot: Record<string, readonly string[]>,
  ): Record<string, readonly string[]> => ({
    ...snapshot,
    reservations: (snapshot['reservations'] ?? []).map((row) =>
      row.startsWith(`${historical.reservationId}:`)
        ? `${historical.reservationId}:abandoned`
        : row,
    ),
    // The hold's own unstarted attempt is abandoned with it, in the same transaction.
    attempts: (snapshot['attempts'] ?? []).map((row) =>
      historicalAttempts.some((id) => row.startsWith(`${id}:`))
        ? `${row.slice(0, row.indexOf(':'))}:abandoned`
        : row,
    ),
  });

  beforeAll(async () => {
    world = await createWorld('rsh');
    lineages = await walkTheOtherLineages(world);
    journey = await walkTheJourney(world);
    // Approved and never picked up: what a production cancel would act on.
    approved = await walkTheJourney(world, { pickup: false });
    unleased = await walkTheJourney(world, { pickup: false });
    historical = await walkTheJourney(world, { pickup: false });

    // I08: authority lost under a live lease, recorded before the restart.
    narrowed = await walkAgentWork(world, 'restart_narrowed');
    await revokeWritesOf(world, narrowed.approver);
    explicit = await walkAgentWork(world, 'restart_explicit');
    const revokedExplicitly = await asAda(world, world.api, '/delegation/revoke', {
      operationId: randomUUID(),
      delegationId: explicit.delegationId,
    });
    expect(revokedExplicitly.code, 'delegation.revoke, the control').toBe('ok');

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
    shortTaskId = String(shortTask.body['recordId']);
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
    // Written only now, with no process serving: the first process's own
    // startup recovery has already run, so only the restarted one can classify it.
    historicalLineageId = await recordHistoricalRejection(world, historical.versionId);
    historicalAttempts = (
      await world.db.admin.execute<{ readonly id: string }>(
        'select id::text as id from public.attempts where business_id = $1 and reservation_id = $2',
        [world.alpha, historical.reservationId],
      )
    ).map((row) => row.id);
    preRestart = await identities(world);
    unleasedBefore = await holdState(world, unleased.reservationId);
    historicalBefore = await holdState(world, historical.reservationId);
    narrowedBefore = await leaseState(world, narrowed.leaseId);
    explicitBefore = await leaseState(world, explicit.leaseId);
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
    before = recovered(await identities(world));
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

  // W06 (a): the baseline is read before `restartContainer`, not after it.
  it('keeps the pre-restart identity baseline, but for the one hold startup recovery classified', async () => {
    const after = await identities(world);
    const causes = await world.db.admin.execute<{ readonly v: string }>(
      `select id::text || ':' || state || ':' || coalesce(classified_cause, '-') as v
         from public.reservations where business_id = $1 order by id`,
      [world.alpha],
    );
    report('http startup recovery', [
      ...(second?.output() ?? '').split('\n').filter((line) => line.startsWith('restart recovery')),
      `historical hold ${historical.reservationId}`,
      ...causes.map((row) => row.v),
    ]);
    expect(after, 'against the baseline read before the container restart').toStrictEqual(
      recovered(preRestart),
    );
    const was = (table: string, id: string): string =>
      `${table} ${String((preRestart[table] ?? []).find((row) => row.startsWith(`${id}:`)))}`;
    const moved = Object.entries(preRestart).flatMap(([table, rows]) =>
      rows.filter((row) => !(after[table] ?? []).includes(row)).map((row) => `${table} ${row}`),
    );
    expect(moved, 'the only rows the restart moved').toStrictEqual([
      was('reservations', historical.reservationId),
      ...historicalAttempts.map((id) => was('attempts', id)),
    ]);
    expect(historicalBefore, 'unclassified before the restart').toMatch(/\|-\|-$/u);
    const classified = await holdState(world, historical.reservationId);
    expect(classified).toMatch(
      new RegExp(`^abandoned\\|[0-9]+\\|lineage_rejected\\|${historicalLineageId}$`, 'u'),
    );
    expect(second?.output(), 'recovered before the port was bound').toContain(
      'restart recovery: alpha committed, 1 classified, 1 released',
    );
    expect(second?.output()).toContain('restart recovery: bravo committed, 0 classified');
    report('http baseline before restartContainer', [
      `tables ${String(Object.keys(preRestart).length)}`,
      `moved ${String(moved.length)} (${historicalBefore} -> ${classified})`,
    ]);
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
    // AGENT-BOUNDARY's late intake (merged at e4cb2ae) keeps the refused second
    // report as a `retained` row naming its refusal; only the first settled.
    expect((await identities(world))['receipts']?.length ?? 0).toBe(receipts + 2);
    const dispositions = await world.db.admin.execute<{ readonly v: string }>(
      `select disposition || ':' || coalesce(refusal_code, '-') as v from public.handback_reports
        where business_id = $1 and lease_id = $2 order by created_at, id`,
      [world.alpha, journey.leaseId],
    );
    expect(dispositions.map((row) => row.v)).toStrictEqual([
      'settled:-',
      'retained:DELEGATION_NOT_LIVE',
    ]);
    expect(await countLeases(world, journey.reservationId)).toBe(leases);
    report('http handback', [
      `first ${once.code}`,
      `second ${String(twice.status)} ${twice.code}`,
      `receipts ${String(receipts)} -> ${String(receipts + 2)} (settled, retained)`,
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
    const v2Detail = v2.body['detail'] as Record<string, string>;
    roundV2 = { gateId: String(v2Detail['gateId']), versionId: String(v2Detail['versionId']) };
    expect(await versionsOf()).toBe('1,2');
    const again = await asAda(world, api, '/task/propose', body);
    expect(again.code, 'replayed version 2').toBe('ok');
    expect(await versionsOf(), 'no duplicate version').toBe('1,2');
    report('http request changes round', [
      `versions ${await versionsOf()}`,
      `v1 gate ${gateState}`,
    ]);
  });

  // G08 across the restart. Round 1 was requested before it, so version 2's
  // gate is round 2 and still takes a request; version 3's would be the third
  // formal round, which `decide.ts` refuses before anything is written.
  it('refuses a third Request Changes round after the restart, and writes nothing', async () => {
    if (roundV2 === undefined) throw new Error('version 2 was not proposed after the restart');
    const secondRound = await asAda(world, api, '/task/decide', {
      operationId: randomUUID(),
      gateId: roundV2.gateId,
      versionId: roundV2.versionId,
      decision: 'request_changes',
      note: 'shorter still, please',
    });
    expect(secondRound.code, 'round 2 on version 2 over HTTP').toBe('ok');
    const v3 = await asAda(world, api, '/task/propose', {
      operationId: randomUUID(),
      recordId: round.taskId,
      lineageId: round.lineageId,
      expectedRevision: await revisionOf(world, round.taskId),
      purpose: 'draft_the_reply',
      maximumMinor: 2000,
      currency: 'AUD',
      payload: { instruction: 'third draft' },
      step: { kind: 'compose', payload: {} },
    });
    expect(v3.code, 'propose version 3 over HTTP').toBe('ok');
    const v3Detail = v3.body['detail'] as Record<string, string>;
    const v3Gate = String(v3Detail['gateId']);

    const snapshot = async (): Promise<readonly string[]> => [
      await scalar(
        world,
        "select state || ':' || round::text || ':' || coalesce(decided_at::text, '-') as v from public.gates where business_id = $1 and id = $2",
        [v3Gate],
      ),
      await scalar(
        world,
        "select string_agg(version::text, ',' order by version) as v from public.proposal_versions where business_id = $1 and lineage_id = $2",
        [round.lineageId],
      ),
      await scalar(
        world,
        "select string_agg(decision || ':' || round::text, ',' order by seq) as v from public.gate_decisions where business_id = $1 and lineage_id = $2",
        [round.lineageId],
      ),
      await scalar(
        world,
        'select count(*)::text as v from public.gate_decisions where business_id = $1',
        [],
      ),
    ];
    const prior = await snapshot();
    expect(prior[0], 'version 3 is round 3 and pending').toMatch(/^pending:3:/u);
    const operationId = randomUUID();
    const third = await asAda(world, api, '/task/decide', {
      operationId,
      gateId: v3Gate,
      versionId: String(v3Detail['versionId']),
      decision: 'request_changes',
      note: 'a third round',
    });
    expect(third.status).toBe(409);
    expect(third.code).toBe('CHANGE_ROUNDS_EXHAUSTED');
    const audits = await world.db.admin.execute<{
      readonly outcome: string;
      readonly refusal_code: string | null;
    }>(
      'select outcome, refusal_code from public.audit_events where business_id = $1 and operation_id = $2',
      [world.alpha, operationId],
    );
    expect(audits.map((row) => [row.outcome, row.refusal_code])).toStrictEqual([
      ['refused', 'CHANGE_ROUNDS_EXHAUSTED'],
    ]);
    expect(await snapshot(), 'nothing moved').toStrictEqual(prior);
    expect(prior[2]).toBe('request_changes:1,request_changes:2');
    report('http third round', [`status ${String(third.status)}`, `code ${third.code}`]);
  });

  // W06's "cancelled lineage resumes silently" needs a lineage cancelled the
  // way a person cancels one. Ledger lines 37-38 make run cancellation and
  // authorised restart required capabilities through owning production
  // interfaces; L3-CONTROLS declared both as `task.cancel` and `task.restart`
  // (merged at 9bf4c69), so both run here over the socket to the new process.
  it('cancels an approved lineage through task.cancel over HTTP, once', async () => {
    const lineageId = await scalar(
      world,
      'select lineage_id::text as v from public.proposal_versions where business_id = $1 and id = $2',
      [approved.versionId],
    );
    const body = {
      operationId: randomUUID(),
      recordId: approved.taskId,
      lineageId,
      reason: 'the person withdrew it',
    };
    const cancelled = await asAda(world, api, '/task/cancel', body);
    // Status too: a missing route answers 404 in plain text, which `call` reads as no refusal.
    expect([cancelled.status, cancelled.code], 'task.cancel').toStrictEqual([200, 'ok']);
    const detail = cancelled.body['detail'] as Record<string, unknown>;
    expect(detail['lineageId']).toBe(lineageId);
    expect(detail['state']).toBe('cancelled');
    expect((await identities(world))['lineages']).toContain(`${lineageId}:cancelled`);
    const registered = await scalar(
      world,
      'select count(*)::text as v from public.operations where business_id = $1 and operation_id = $2',
      [body.operationId],
    );
    expect(registered, 'operations rows for the cancel').toBe('1');

    const settled = await identities(world);
    const replay = await asAda(world, api, '/task/cancel', body);
    expect(replay.body, 'byte-identical replay').toStrictEqual(cancelled.body);
    expect(await identities(world), 'the replay adds nothing').toStrictEqual(settled);

    const leases = await countLeases(world, approved.reservationId);
    const pickup = await asAgent(world, api, '/task/pickup', {
      operationId: randomUUID(),
      reservationId: approved.reservationId,
    });
    expect([pickup.status, pickup.code]).toStrictEqual([409, 'RESERVATION_NOT_CLAIMABLE']);
    expect(await countLeases(world, approved.reservationId)).toBe(leases);
    report('http task.cancel', [
      `${String(cancelled.status)} ${cancelled.code}`,
      `operations ${registered}`,
      `pickup ${String(pickup.status)} ${pickup.code}`,
    ]);
  });

  it('restarts a cancelled lineage through task.restart over HTTP as a new lineage', async () => {
    const old = lineages.cancelledLineageId;
    const body = { operationId: randomUUID(), recordId: lineages.cancelledTaskId, lineageId: old };
    const restarted = await asAda(world, api, '/task/restart', body);
    expect([restarted.status, restarted.code], 'task.restart').toStrictEqual([200, 'ok']);
    const detail = restarted.body['detail'] as Record<string, unknown>;
    const fresh = String(detail['lineageId']);
    expect(fresh).not.toBe(old);
    expect(detail['restartsLineageId']).toBe(old);
    expect(detail['version']).toBe(1);
    const after = await identities(world);
    expect(after['lineages']).toContain(`${old}:cancelled`);
    expect(after['gates']).toContain(`${String(detail['gateId'])}:pending`);
    const decisions = await scalar(
      world,
      'select count(*)::text as v from public.gate_decisions where business_id = $1 and gate_id = $2',
      [detail['gateId']],
    );
    expect(decisions, 'decisions on the new gate').toBe('0');
    const holds = await scalar(
      world,
      'select count(*)::text as v from public.reservations where business_id = $1 and version_id = $2',
      [detail['versionId']],
    );
    expect(holds, 'holds on the new version').toBe('0');

    const replay = await asAda(world, api, '/task/restart', body);
    expect(replay.body, 'byte-identical replay').toStrictEqual(restarted.body);
    const restarts = await scalar(
      world,
      'select count(*)::text as v from public.proposal_lineages where business_id = $1 and restarts_lineage_id = $2',
      [old],
    );
    expect(restarts, 'lineages restarting the old one').toBe('1');
    const pickup = await asAgent(world, api, '/task/pickup', {
      operationId: randomUUID(),
      reservationId: lineages.cancelledReservationId,
    });
    expect(pickup.code, 'the old hold after the restart').toBe('RESERVATION_NOT_CLAIMABLE');
    report('http task.restart', [
      `${String(restarted.status)} ${restarted.code}`,
      `version ${String(detail['version'])}`,
      `decisions ${decisions}`,
      `holds ${holds}`,
      `restarts ${restarts}`,
    ]);
  });

  // G06: the owner's expired projection, on the database clock, after the restart.
  it('reads the lapsed gate as expired over HTTP, with the stored row still pending', async () => {
    const read = await asAda(world, api, '/task/read', {
      operationId: randomUUID(),
      recordId: shortTaskId,
    });
    expect([read.status, read.code]).toStrictEqual([200, 'ok']);
    const gates: Record<string, unknown>[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (object['id'] === shortGate.gateId && 'expired' in object) gates.push(object);
        for (const item of Object.values(object)) walk(item);
      }
    };
    walk(read.body);
    expect(gates.map((gate) => [gate['state'], gate['expired']])).toStrictEqual([
      ['expired', true],
    ]);
    const stored = await scalar(
      world,
      'select state as v from public.gates where business_id = $1 and id = $2',
      [shortGate.gateId],
    );
    expect(stored, 'the stored row, never rewritten').toBe('pending');
    report('http expired projection', [`read expired`, `stored ${stored}`]);
  });

  // W04: an approved, unleased hold is neither abandoned by the restart nor by its recovery.
  it('keeps an approved unleased hold held across the restart, and it is still claimable', async () => {
    expect(await holdState(world, unleased.reservationId), 'the hold as snapshotted').toBe(
      unleasedBefore,
    );
    expect(await countLeases(world, unleased.reservationId)).toBe(0);
    const picked = await asAgent(world, api, '/task/pickup', {
      operationId: randomUUID(),
      reservationId: unleased.reservationId,
    });
    expect([picked.status, picked.code], 'pickup after the restart').toStrictEqual([200, 'ok']);
    expect(await countLeases(world, unleased.reservationId)).toBe(1);
    report('http unleased hold', [`before ${unleasedBefore}`, `pickup ${picked.code}`]);
  });

  // I08: the cause the revoking transaction recorded outlives the restart.
  it('answers DELEGATION_NARROWED after the restart for authority lost before it, with no effect', async () => {
    expect(narrowedBefore, 'revoked by the grant loss, before the restart').toMatch(
      /\|true\|false\|0$/u,
    );
    const answers: string[] = [];
    // AGENT-BOUNDARY-2 has not merged at this head: a narrowed agent's
    // handback keeps no report, so both calls leave everything as it was.
    for (const name of ['/task/heartbeat', '/task/handback'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one call, then the state it left
      const answer = await agentOnLease(api, narrowed, name);
      expect([answer.status, answer.code], name).toStrictEqual([403, 'DELEGATION_NARROWED']);
      // eslint-disable-next-line no-await-in-loop
      expect(await leaseState(world, narrowed.leaseId), `${name} moved nothing`).toBe(
        narrowedBefore,
      );
      answers.push(`${name} ${String(answer.status)} ${answer.code}`);
    }
    expect(explicitBefore, 'the control, revoked explicitly').not.toBe(narrowedBefore);
    // The control keeps DELEGATION_NOT_LIVE, and AGENT-BOUNDARY's late intake
    // keeps its report as one retained row; nothing else moves.
    for (const [name, reports] of [
      ['/task/heartbeat', '0'],
      ['/task/handback', '1'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await agentOnLease(api, explicit, name);
      expect([answer.status, answer.code], `control ${name}`).toStrictEqual([
        401,
        'DELEGATION_NOT_LIVE',
      ]);
      // eslint-disable-next-line no-await-in-loop
      expect(await leaseState(world, explicit.leaseId), `control ${name}`).toBe(
        explicitBefore.replace(/\|0$/u, `|${reports}`),
      );
      answers.push(`control ${name} ${String(answer.status)} ${answer.code} reports ${reports}`);
    }
    report('http authority loss', answers);
  });

  // Startup recovery again: a second restart of the process classifies nothing twice.
  it('does not classify the historical hold again on a second process restart', async () => {
    const classified = await holdState(world, historical.reservationId);
    const settled = await identities(world);
    const port = declaredApiPort();
    const previous = second;
    await second?.stop();
    second = await startApi(world, port);
    expect(second.pid).not.toBe(previous?.pid);
    expect(second.output()).toContain('restart recovery: alpha committed, 0 classified');
    expect(await holdState(world, historical.reservationId)).toBe(classified);
    expect(await identities(world)).toStrictEqual(settled);
    report('http recovery second restart', [
      `pid ${String(previous?.pid)} -> ${String(second.pid)}`,
      `hold ${classified}`,
    ]);
  });
});
