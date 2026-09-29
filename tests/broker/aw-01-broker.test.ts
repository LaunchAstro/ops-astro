// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 on the database: a priced model call made through the broker, with
// custody's real process and the replay provider on loopback, against work
// that was really proposed, approved and picked up through the command entry.
//
// The invariant `reservation_before_dispatch_through_broker` is first: the
// call's hold is a committed row at the operation's maximum before custody is
// asked, and a call the reservation cannot cover is refused and recorded with
// nothing sent.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  promptCopyRegistered,
  reserveModelCall,
  sendReservedCall,
  type AuditNote,
  sweepModelCalls,
  type Broker,
  type BrokerRoute,
  type ModelCallField,
  type ModelCaller,
  type ModelCallRequest,
} from '../../packages/core-custody/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  approve,
  createTask,
  freshPurpose,
  liveWork,
  openSchedules,
  propose,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { statusOf } from '../../packages/core-records/src/register.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

const digestOf = (detail: unknown): string =>
  createHash('sha256').update(JSON.stringify(detail)).digest('hex');

const PLANTED_PROMPT = `planted-prompt-${randomUUID()}`;

const CLOUD: BrokerRoute = {
  key: 'replay',
  reach: 'cloud',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
};

const LOCAL: BrokerRoute = { ...CLOUD, key: 'on_premises', reach: 'local' };

const ONE_AT_A_TIME: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_single',
  concurrency: 1,
};

const NOT_RECONCILABLE: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_unreconcilable',
  nothingHappened: 'not_reconcilable',
};

/** Business-internal fields only: the cloud route may carry them. */
const INTERNAL: readonly ModelCallField[] = [
  { name: 'tone', source: 'business_internal', value: PLANTED_PROMPT },
];

describe.skipIf(serverUrl === undefined)('AW-01 the broker on the database', () => {
  let s: Schedules;
  let world: CustodyWorld;
  let broker: Broker;

  const withRoutes = (routes: readonly BrokerRoute[]): Broker => ({ ...broker, routes });

  const audit = async (tx: TenantQuery, note: AuditNote): Promise<void> => {
    await writeAuditEvent(tx, {
      actorId: s.agentActorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  };

  const steps = new Map<string, string>();
  const stepOf = async (work: Work): Promise<string> => {
    const leaseId = String(work.picked['leaseId']);
    const known = steps.get(leaseId);
    if (known !== undefined) return known;
    const [row] = await s.db.admin.execute<{ id: string }>(
      `select st.id from public.planned_steps st join public.leases l on l.run_id = st.run_id
        where l.id = $1 order by st.ordinal limit 1`,
      [leaseId],
    );
    if (row === undefined) throw new Error('no step for the lease');
    steps.set(leaseId, row.id);
    return row.id;
  };

  const requestFor = (work: Work, overrides: Partial<ModelCallRequest> = {}): ModelCallRequest => ({
    leaseId: String(work.picked['leaseId']),
    fence: Number(work.picked['fence']),
    stepId: steps.get(String(work.picked['leaseId'])) ?? 'unknown',
    operation: REPLAY_COMPOSE.key,
    fields: INTERNAL,
    ...overrides,
  });

  /** The agent, under the delegation its pickup of this work minted. */
  const caller = (work: Work): ModelCaller => ({
    actorId: s.agentActorId,
    delegationId: String(work.picked['delegationId']),
    attendedByPersonId: null,
  });

  const call = async (work: Work, overrides: Partial<ModelCallRequest> = {}, with_ = broker) => {
    await stepOf(work);
    return await callModel(s.db.app, s.business, caller(work), requestFor(work, overrides), with_);
  };

  const rowsOf = async (callId: string | null): Promise<readonly Record<string, unknown>[]> =>
    callId === null
      ? []
      : await s.db.app.withBusiness(s.business, async (tx) =>
          tx.query(`select * from public.model_calls where business_id = $1 and id = $2`, [
            tx.businessId,
            callId,
          ]),
        );

  const rowsOnLease = async (work: Work): Promise<readonly Record<string, unknown>[]> =>
    await s.db.admin.execute(`select id from public.model_calls where lease_id = $1`, [
      work.picked['leaseId'],
    ]);

  const callCount = async (): Promise<number> =>
    Number(
      (
        await s.db.admin.execute<{ n: string }>(
          `select count(*)::text as n from public.model_calls`,
        )
      )[0]?.n,
    );

  beforeAll(async () => {
    s = await openSchedules('aw01broker', 1_000_000);
    world = await openCustodyWorld();
    broker = {
      custody: world.custody,
      operations: catalogue([REPLAY_COMPOSE, ONE_AT_A_TIME, NOT_RECONCILABLE]),
      providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
      routes: [CLOUD],
      installation: 'here',
      audit,
    };
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    await s?.db.drop();
  });

  it('reservation_before_dispatch_through_broker', async () => {
    const work = await liveWork(s, 'the invariant', 2_000);
    world.provider.mode('slow');
    const seenBefore = world.provider.seen.length;
    const pending = call(work, {}, withRoutes([CLOUD]));
    await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seenBefore + 1);
    // The provider has the request, and the hold was committed before it did.
    const held = await s.db.admin.execute<{
      state: string;
      reserved_minor: string;
      started: boolean;
    }>(
      `select state, reserved_minor::text as reserved_minor, started_at >= accepted_at as started
         from public.model_calls where lease_id = $1`,
      [work.picked['leaseId']],
    );
    expect(held).toEqual([{ state: 'dispatched', reserved_minor: '500', started: true }]);
    await pending;

    // A call the reservation cannot cover is refused, recorded, and never sent.
    const small = await liveWork(s, 'too small to cover', 300);
    const before = world.provider.seen.length;
    const refused = await call(small);
    expect(refused).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
    expect(world.provider.seen.length).toBe(before);
    const recorded = await rowsOf(refused.ok ? null : (refused as { callId: string }).callId);
    expect(recorded).toMatchObject([
      { state: 'refused', refusal_code: 'BUDGET_UNAVAILABLE', reserved_minor: '0' },
    ]);
  });

  it('AW-01 reservation and settlement: held at the maximum, settled at the price, the rest released', async () => {
    const work = await liveWork(s, 'one priced call', 2_000);
    world.provider.mode('answer');
    const result = await call(work);
    expect(result).toEqual({
      ok: true,
      callId: expect.any(String),
      text: 'Drafted.',
      reservedMinor: 500,
      actualMinor: 100,
      releasedMinor: 400,
    });
    const [row] = await rowsOf(result.ok ? result.callId : null);
    expect(row).toMatchObject({
      state: 'settled',
      reserved_minor: '500',
      actual_minor: '100',
      route_key: 'replay',
      route_reach: 'cloud',
      credential_kind: 'api_key',
      account: 'replay-account-1',
    });
    // Accepted, started, completed: three facts; the operation declares no landing.
    expect(row?.['accepted_at']).toBeInstanceOf(Date);
    expect(row?.['started_at']).toBeInstanceOf(Date);
    expect(row?.['completed_at']).toBeInstanceOf(Date);
    expect(row?.['landed_at']).toBeNull();
    const detail = {
      callId: result.ok ? result.callId : '',
      operation: REPLAY_COMPOSE.key,
      route: 'replay',
      credentialKind: 'api_key',
      reservedMinor: 500,
      actualMinor: 100,
      releasedMinor: 400,
    };
    const events = await s.db.admin.execute<{ command: string; outcome: string }>(
      `select command, outcome from public.audit_events where payload_digest = $1`,
      [digestOf(detail)],
    );
    expect(events).toEqual([{ command: 'model.call_dispatched', outcome: 'applied' }]);
  });

  it('AW-01 observed above the hold: refused, the amount recorded and audited, held at the maximum', async () => {
    // 1 000 held for the run: the held 500 leaves room for one more call, not two.
    const work = await liveWork(s, 'a costly answer', 1_000);
    world.provider.mode('costly');
    const result = await call(work);
    expect(result).toMatchObject({
      ok: false,
      code: 'LIABILITY_UNKNOWN',
      heldMinor: 500,
      observedMinor: 1000,
    });
    const callId = (result as { callId: string }).callId;
    expect(await rowsOf(callId)).toMatchObject([
      { state: 'liability_unknown', observed_minor: '1000', ended_at: null },
    ]);
    const refusal = await s.db.admin.execute<{ attempted: Record<string, unknown> }>(
      `select attempted from public.audit_events where command = 'model.call_held' and attempted->>'callId' = $1`,
      [callId],
    );
    expect(refusal).toMatchObject([{ attempted: { heldMinor: 500, observedMinor: 1000 } }]);
    // The held maximum stays held: the next call finds less room.
    world.provider.mode('answer');
    const next = await call(work);
    expect(next).toMatchObject({ ok: true, actualMinor: 100 });
    const third = await call(work);
    expect(third).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  });

  it('AW-01 positive proof that nothing happened releases the whole hold', async () => {
    const work = await liveWork(s, 'nothing happened', 2_000);
    world.provider.mode('nothing_happened');
    const result = await call(work);
    expect(result).toMatchObject({
      ok: false,
      code: 'CALL_RELEASED',
      reason: 'rejected_before_processing',
    });
    expect(await rowsOf((result as { callId: string }).callId)).toMatchObject([
      { state: 'released' },
    ]);
  });

  it('AW-01 hostile provider: each answer is refused or bounded and moves no money beyond the hold', async () => {
    for (const mode of ['oversized', 'redirect', 'malformed', 'slow'] as const) {
      // eslint-disable-next-line no-await-in-loop
      const work = await liveWork(s, `hostile ${mode}`, 2_000);
      world.provider.mode(mode);
      // eslint-disable-next-line no-await-in-loop
      const result = await call(work);
      expect(result, mode).toMatchObject({
        ok: false,
        code: 'LIABILITY_UNKNOWN',
        heldMinor: 500,
        drop: 'dropped_no_answer',
      });
      // eslint-disable-next-line no-await-in-loop
      const [row] = await rowsOf((result as { callId: string }).callId);
      expect(row, mode).toMatchObject({
        state: 'liability_unknown',
        reserved_minor: '500',
        actual_minor: null,
      });
    }
    const planted = await liveWork(s, 'hostile planted', 2_000);
    world.provider.mode('planted');
    const before = world.provider.seen.length;
    const result = await call(planted);
    expect(result).toMatchObject({ ok: true, actualMinor: 100 });
    expect(world.provider.seen.length).toBe(before + 1);
  });

  it('AW-01 six facts: none is taken from the caller', async () => {
    const work = await liveWork(s, 'six facts', 2_000);
    world.provider.mode('answer');
    const before = await callCount();
    const other = await liveWork(s, 'another run', 2_000);
    for (const overrides of [
      { fence: Number(work.picked['fence']) + 1 },
      { leaseId: randomUUID() },
      { stepId: await stepOf(other) },
      { stepId: randomUUID() },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await call(work, overrides)).toEqual({
        ok: false,
        code: 'LEASE_NOT_OWNED',
        callId: null,
      });
    }
    await stepOf(work);
    const stranger = await callModel(
      s.db.app,
      s.business,
      { ...caller(work), actorId: randomUUID() },
      requestFor(work),
      broker,
    );
    expect(stranger).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
    expect(await callCount()).toBe(before);
    expect(await call(work, { operation: 'model.undeclared' })).toMatchObject({
      ok: false,
      code: 'OPERATION_NOT_CATALOGUED',
    });
    expect(await call(work, { operation: NOT_RECONCILABLE.key })).toMatchObject({
      ok: false,
      code: 'EFFECT_NOT_RECONCILABLE',
    });
  });

  it('AW-01 six facts: the lease carries the delegation the caller resolved', async () => {
    // One agent, two pickups, two live delegations: each lease is only its own.
    const first = await liveWork(s, 'the first pickup', 2_000);
    const second = await liveWork(s, 'the second pickup', 2_000);
    await stepOf(first);
    const seen = world.provider.seen.length;
    for (const delegationId of [String(second.picked['delegationId']), null]) {
      // eslint-disable-next-line no-await-in-loop
      const crossed = await callModel(
        s.db.app,
        s.business,
        { ...caller(first), delegationId },
        requestFor(first),
        broker,
      );
      expect(crossed).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
    }
    expect(world.provider.seen.length).toBe(seen);
    expect(await rowsOnLease(first)).toEqual([]);
  });

  it('AW-01 personal information stays local, on the broker: refused before any route, then only the local one', async () => {
    const work = await liveWork(s, 'personal information', 2_000);
    world.provider.mode('answer');
    const before = world.provider.seen.length;
    const personal: readonly ModelCallField[] = [
      {
        name: 'instruction',
        source: 'client_row',
        value: 'Reply to jo@example.test about the enquiry',
      },
    ];
    const refused = await call(work, { fields: personal }, withRoutes([CLOUD]));
    expect(refused).toMatchObject({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
      words: expect.stringContaining('waits on a local model'),
    });
    expect(world.provider.seen.length).toBe(before);
    const local = await call(work, { fields: personal }, withRoutes([CLOUD, LOCAL]));
    expect(local.ok).toBe(true);
    expect(await rowsOf((local as { callId: string }).callId)).toMatchObject([
      { route_key: 'on_premises', route_reach: 'local' },
    ]);
    const internal = await call(work, {}, withRoutes([CLOUD, LOCAL]));
    expect(await rowsOf((internal as { callId: string }).callId)).toMatchObject([
      { route_key: 'replay' },
    ]);
  });

  it('AW-01 subscription refusal, on the broker: an unattended run on a subscription is refused by name', async () => {
    const work = await liveWork(s, 'subscription', 2_000);
    const before = world.provider.seen.length;
    const subscription = { ...CLOUD, credentialKind: 'subscription' as const };
    expect(await call(work, {}, withRoutes([subscription]))).toMatchObject({
      ok: false,
      code: 'SUBSCRIPTION_UNATTENDED',
    });
    expect(
      await call(work, {}, withRoutes([{ ...subscription, installation: 'there' }])),
    ).toMatchObject({
      ok: false,
      code: 'SUBSCRIPTION_OTHER_TENANT',
    });
    expect(world.provider.seen.length).toBe(before);
  });

  it('AW-01 rate limit: past the durable ceiling the caller is told to wait, and nothing is written', async () => {
    const work = await liveWork(s, 'one at a time', 2_000);
    world.provider.mode('slow');
    const first = call(work, { operation: ONE_AT_A_TIME.key });
    await expect
      .poll(async () =>
        Number(
          (
            await s.db.admin.execute<{ n: string }>(
              `select count(*)::text as n from public.model_calls where operation_key = $1 and state = 'dispatched'`,
              [ONE_AT_A_TIME.key],
            )
          )[0]?.n,
        ),
      )
      .toBe(1);
    const before = await callCount();
    expect(await call(work, { operation: ONE_AT_A_TIME.key })).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      callId: null,
      retryAfterSeconds: 5,
    });
    expect(await callCount()).toBe(before);
    await first;
  });

  it('AW-01 revocation mid-transfer: that transfer finishes, nothing further is granted', async () => {
    const work = await liveWork(s, 'revoked mid-call', 2_000);
    world.provider.mode('slow');
    const seen = world.provider.seen.length;
    const pending = call(work, {}, withRoutes([CLOUD]));
    await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);
    await s.db.admin.execute(
      `update public.delegations set revoked_at = clock_timestamp(), revocation_cause = 'delegation_revoked'
        where id = (select delegation_id from public.leases where id = $1)`,
      [work.picked['leaseId']],
    );
    const inFlight = await pending;
    expect(inFlight).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
    world.provider.mode('answer');
    expect(await call(work)).toEqual({ ok: false, code: 'AUTHORITY_LOST', callId: null });
  });

  it('AW-01 revocation between the hold and the send: nothing is sent and the hold is released', async () => {
    const work = await liveWork(s, 'revoked before the send', 2_000);
    await stepOf(work);
    world.provider.mode('answer');
    const seen = world.provider.seen.length;
    // The hold commits in the caller's transaction, as model.call's does.
    const reserving = await s.db.app.withBusiness(
      s.business,
      async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
    );
    if (!reserving.ok) throw new Error(`reserve refused ${reserving.code}`);
    await s.db.admin.execute(
      `update public.delegations set revoked_at = clock_timestamp(), revocation_cause = 'delegation_revoked'
        where id = (select delegation_id from public.leases where id = $1)`,
      [work.picked['leaseId']],
    );
    const sent = await sendReservedCall(
      s.db.app,
      s.business,
      caller(work),
      requestFor(work),
      reserving.reserved,
      broker,
    );
    expect(sent).toEqual({ ok: false, code: 'AUTHORITY_LOST', callId: reserving.reserved.callId });
    expect(world.provider.seen.length).toBe(seen);
    expect(await rowsOf(reserving.reserved.callId)).toMatchObject([
      { state: 'released', started_at: null },
    ]);
  });

  it('AW-01 expired lease: the cost settles and the work is refused', async () => {
    const work = await liveWork(s, 'expires mid-call', 2_000);
    await stepOf(work);
    world.provider.mode('slow');
    const seen = world.provider.seen.length;
    const pending = callModel(s.db.app, s.business, caller(work), requestFor(work), {
      ...broker,
      operations: catalogue([{ ...REPLAY_COMPOSE, timeoutMs: 20_000 }]),
    });
    await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);
    await s.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() where id = $1`,
      [work.picked['leaseId']],
    );
    world.provider.mode('answer');
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
  });

  it('AW-01 recovery: custody lost mid-dispatch holds the maximum as dropped_worker_lost, fault ours, never resent', async () => {
    const lost = await openCustodyWorld();
    try {
      const work = await liveWork(s, 'custody lost', 2_000);
      lost.provider.mode('slow');
      const pending = call(work, {}, { ...broker, custody: lost.custody });
      await expect.poll(() => lost.provider.seen.length, { timeout: 5_000 }).toBe(1);
      lost.custody.kill();
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        code: 'LIABILITY_UNKNOWN',
        heldMinor: 500,
        drop: 'dropped_worker_lost',
      });
      expect(await rowsOf((result as { callId: string }).callId)).toMatchObject([
        { state: 'liability_unknown', fault: 'ours', drop_state: 'dropped_worker_lost' },
      ]);
      expect(lost.provider.seen.length).toBe(1);
    } finally {
      await lost.close();
    }
  });

  it('AW-01 recovery: the sweep holds a started call and releases one never sent', async () => {
    const work = await liveWork(s, 'swept', 2_000);
    const step = await stepOf(work);
    const [started, unsent] = [randomUUID(), randomUUID()];
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const [id, state] of [
        [started, 'dispatched'],
        [unsent, 'reserved'],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop
        await tx.query(
          `insert into public.model_calls
             (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
              state, reserved_minor, route_key, route_reach, credential_kind, started_at)
           select l.business_id, $2, l.run_id, $3, l.id, r.version_id, r.id, 'model.replay_compose',
                  $4, 500, 'replay', 'cloud', 'api_key', case when $4 = 'dispatched' then clock_timestamp() end
             from public.leases l join public.reservations r on r.id = l.reservation_id
            where l.business_id = $1 and l.id = $5`,
          [tx.businessId, id, step, state, work.picked['leaseId']],
        );
      }
    });
    await s.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() where id = $1`,
      [work.picked['leaseId']],
    );
    const swept = await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
    expect(swept).toEqual({ held: 1, released: 1 });
    expect(await rowsOf(started)).toMatchObject([
      { state: 'liability_unknown', reserved_minor: '500' },
    ]);
    expect(await rowsOf(unsent)).toMatchObject([{ state: 'released' }]);
  });

  it('AW-01 copy register: every sent prompt was registered first, and a registration is never rewritten', async () => {
    world.provider.mode('answer');
    expect((await call(await liveWork(s, 'a registered copy', 2_000))).ok).toBe(true);
    const sent = await s.db.admin.execute<{ id: string }>(
      `select id from public.model_calls where state = 'settled' and business_id = $1`,
      [s.business],
    );
    expect(sent.length).toBeGreaterThan(0);
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const { id } of sent) {
        // eslint-disable-next-line no-await-in-loop
        expect(await promptCopyRegistered(tx, id)).toBe(true);
      }
      expect(await promptCopyRegistered(tx, randomUUID())).toBe(false);
    });
    await expect(
      s.db.app.withBusiness(s.business, async (tx) =>
        tx.query(
          `update public.copy_registrations set retention_class = 'record' where business_id = $1`,
          [tx.businessId],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
    // Past the grant, the table itself refuses: even the owner cannot rewrite one.
    await expect(
      s.db.admin.execute(`update public.copy_registrations set retention_class = 'record'`),
    ).rejects.toThrow(/append only/u);
    await expect(s.db.admin.execute(`delete from public.copy_registrations`)).rejects.toThrow(
      /append only/u,
    );
  });

  it('AW-01 isolation: another business, another client, another person under a live delegation', async () => {
    world.provider.mode('answer');
    const mine = await liveWork(s, 'alpha work', 2_000);
    await stepOf(mine);
    const madeUp = await call(mine, { leaseId: randomUUID() });
    const before = await callCount();
    const seen = world.provider.seen.length;
    const refusedAlike = (result: unknown): void => {
      expect(result).toEqual(madeUp);
      expect(result).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
    };
    expect(statusOf('LEASE_NOT_OWNED')).toBe(403);

    // 1. Another business: its lease, presented here, reads as made up; and ours, there.
    const bravo = await openSchedules('aw01bravo', 1_000_000);
    try {
      const theirs = await liveWork(bravo, 'bravo work', 2_000);
      const [theirStep] = await bravo.db.admin.execute<{ id: string }>(
        `select st.id from public.planned_steps st join public.leases l on l.run_id = st.run_id where l.id = $1`,
        [theirs.picked['leaseId']],
      );
      refusedAlike(
        await call(mine, {
          leaseId: String(theirs.picked['leaseId']),
          fence: Number(theirs.picked['fence']),
          stepId: String(theirStep?.id),
        }),
      );
      refusedAlike(
        await callModel(
          s.db.app,
          s.business,
          { ...caller(mine), actorId: bravo.agentActorId },
          requestFor(mine),
          broker,
        ),
      );
    } finally {
      await bravo.db.drop();
    }

    // 2. Another client in the same business: client X, on its own shared task, presents the lease on client Y's.
    const taskX = await createTask(s, 'client X task');
    // As in CQ-7: a person outside the staff holding one record-scoped grant on its own task (R4).
    const clientX = await enrol(s.db.app, s.business, 'client-x');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, clientX, 'read', { kind: 'record', id: taskX });
    });
    refusedAlike(
      await callModel(
        s.db.app,
        s.business,
        { ...caller(mine), actorId: clientX.actorId },
        requestFor(mine),
        broker,
      ),
    );

    // 3. Another person's agent, under its own live delegation, presents our agent's lease.
    const other = await enrol(s.db.app, s.business, 'other-decider');
    const otherSubject = `agent-${randomUUID()}`;
    const otherAgent = randomUUID();
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, other, action, undefined, true);
      }
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        s.business,
        otherAgent,
      ]);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [s.business, randomUUID(), await insertLogin(tx, otherSubject), otherAgent, other.actorId],
      );
    });
    const theirTask = await createTask(s, 'the other agent task');
    const decision = await approve(
      s,
      await propose(s, theirTask, { maximumMinor: 2_000, purpose: freshPurpose() }),
    );
    const picked = await executeAgentCommand(
      s.db.app,
      s.business,
      { provider: 'supabase', subject: otherSubject },
      undefined,
      {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: decision['reservationId'],
        leaseSeconds: 600,
      } as never,
    );
    expect(isCommandRefusal(picked as object)).toBe(false);
    const live = await s.db.admin.execute<{ n: string }>(
      `select count(*)::text as n from public.delegations
        where agent_actor_id = $1 and revoked_at is null and expires_at > now()`,
      [otherAgent],
    );
    expect(live[0]?.n).toBe('1');
    refusedAlike(
      await callModel(
        s.db.app,
        s.business,
        { ...caller(mine), actorId: otherAgent },
        requestFor(mine),
        broker,
      ),
    );

    // Nothing was written or sent for any crossing, and our own call still works.
    expect(await callCount()).toBe(before);
    expect(world.provider.seen.length).toBe(seen);
    expect((await call(mine)).ok).toBe(true);
  });

  it('AW-01 canary: the planted key and the planted prompt reach no row, audit payload or answer', async () => {
    const tables = await s.db.admin.execute<{ dump: string }>(
      `select coalesce(string_agg(t::text, ' '), '') as dump from (
         select row_to_json(m)::text as t from public.model_calls m
         union all select row_to_json(a)::text from public.audit_events a
         union all select row_to_json(c)::text from public.copy_registrations c) rows`,
    );
    const dump = tables[0]?.dump ?? '';
    expect(dump).not.toContain(world.canary);
    expect(dump).not.toContain(PLANTED_PROMPT);
    expect(world.custody.stderr()).not.toContain(world.canary);
    // The provider did receive the prompt: the search above is not vacuous.
    expect(world.provider.seen.some((request) => request.body.includes(PLANTED_PROMPT))).toBe(true);
  });
});
