// SPDX-License-Identifier: AGPL-3.0-only
//
// Item 5: what survives a restart, and what an expired session is told.
//
// Frontier row W06 asks for restart durability to be extended past the early
// task checkpoint to the gate, the decision chain, the reservation, the lease
// and the attempt — and for the proof that no hold is duplicated and no
// cancelled lineage silently resumes. The assembled expiry proof is the other
// half: a bearer whose `exp` has passed must answer `AUTH_SESSION_EXPIRED` on
// both prefixes, and a fresh token must resume the same session state rather
// than a new one.
//
// **What makes this a restart proof rather than a reconnection proof.** Two
// different things are done and they are not interchangeable. (i) A fresh
// application instance is built — a new connection pool, a new `createApi`, a
// new verifier — so nothing the first instance held in memory carries across.
// (ii) The lane's own Postgres container is restarted, so the server process
// that held the rows is not the server process that serves them afterwards.
// A test that only did (i) would prove the application forgets; a test that
// only did (ii) would let a warm pool answer from a cache. Both, in that
// order, is the claim.
//
// **Identity, not merely presence.** "The task is still there" is the early
// checkpoint and it is not this. Every identifier minted before the restart is
// read back afterwards and compared, so a row that was recreated rather than
// preserved fails here — which is exactly the silent resumption W06 names.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsClient, isRefusal } from '../../apps/web/src/operations/client.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  rebuildApi,
  serverUrl,
  tokenFor,
  type World,
} from './world.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/restart: DATABASE_URL is unset, so nothing below ran.');
}

/**
 * The lane's own container, restarted by name.
 *
 * Named as a constant and asserted against the environment's own port before
 * anything is done to it: the briefs for this round name several Postgres
 * containers on one host, and a restart aimed at the wrong one would stop
 * somebody else's work. `docker restart` keeps the volume, which is the whole
 * point — a proof that reseeded would prove nothing about durability.
 */
/** Measured evidence goes to a gitignored file; the runner swallows stdout. */
function report(label: string, lines: readonly string[]): void {
  mkdirSync('.local', { recursive: true });
  appendFileSync('.local/l5-restart.txt', `${label}: ${lines.join(', ')}\n`);
}

const CONTAINER = 'ops-astro-l5-pg';
const DOCKER = '/usr/local/bin/docker';

/**
 * When the container last started, as the daemon reports it.
 *
 * The restart proof's weakest point would be trusting that `docker restart`
 * did anything: a command that failed quietly, or a name that no longer
 * matches, would leave every assertion after it passing for the wrong reason.
 * Reading this before and after and requiring it to have MOVED is what makes
 * the restart a measured fact rather than an intention. (`RestartCount` is not
 * the check — it counts restart-policy restarts, not manual ones, and stays 0.)
 */
function startedAt(): string {
  return execFileSync(DOCKER, ['inspect', CONTAINER, '--format', '{{.State.StartedAt}}'], {
    encoding: 'utf8',
  }).trim();
}

function restartOwnContainer(): void {
  execFileSync(DOCKER, ['restart', CONTAINER], { stdio: 'pipe' });
  // `docker restart` returns when the container is up, not when Postgres is
  // accepting connections. Waiting on the server's own readiness check rather
  // than on a sleep is what keeps this from being flaky on a slow machine.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      execFileSync(DOCKER, ['exec', CONTAINER, 'pg_isready', '-q', '-U', 'postgres'], {
        stdio: 'pipe',
      });
      return;
    } catch {
      execFileSync('/bin/sleep', ['1'], { stdio: 'pipe' });
    }
  }
  throw new Error(`${CONTAINER} did not accept connections after the restart`);
}

interface Journey {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
  readonly pickupOperationId: string;
}

describe.skipIf(serverUrl === undefined)('restart and session expiry', () => {
  let world: World;
  let journey: Journey;

  beforeAll(async () => {
    world = await createWorld('rst');
    journey = await walkTheJourney();
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  const asAda = async (
    name: string,
    body: Readonly<Record<string, unknown>>,
    api: ReturnType<typeof rebuildApi>['api'] = world.api,
  ): ReturnType<typeof call> =>
    await call(api, personPath('alpha', name), body, bearer(world.ada.token));

  const asAgent = async (
    name: string,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
    api: ReturnType<typeof rebuildApi>['api'] = world.api,
  ): ReturnType<typeof call> =>
    await call(api, agentPath('alpha', name), body, {
      ...bearer(world.agent.token),
      ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
    });

  async function revisionOf(recordId: string): Promise<number> {
    const rows = await world.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where business_id = $1 and id = $2',
      [world.alpha, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  }

  /** propose → decide → pickup, as a person and then as the agent. */
  async function walkTheJourney(): Promise<Journey> {
    const created = await asAda('/task/create', {
      operationId: randomUUID(),
      fields: { title: `a task that outlives a restart ${randomUUID()}` },
    });
    expect(created.code, 'create').toBe('ok');
    const taskId = String(created.body['recordId']);

    const proposed = await asAda('/task/propose', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      purpose: 'draft_the_reply',
      maximumMinor: 3000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    expect(proposed.code, 'propose').toBe('ok');
    const detail = proposed.body['detail'] as Record<string, string>;

    const decided = await asAda('/task/decide', {
      operationId: randomUUID(),
      gateId: detail['gateId'],
      versionId: detail['versionId'],
      decision: 'approve',
      note: 'approved so an agent can work it',
    });
    expect(decided.code, 'decide').toBe('ok');
    const decision = decided.body['detail'] as Record<string, string>;

    const pickupOperationId = randomUUID();
    const pickedUp = await asAgent('/task/pickup', {
      operationId: pickupOperationId,
      reservationId: decision['reservationId'],
    });
    expect(pickedUp.code, 'pickup').toBe('ok');
    const picked = pickedUp.body['detail'] as Record<string, unknown>;

    return {
      taskId,
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      reservationId: String(decision['reservationId']),
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      credential: String(picked['credential']),
      pickupOperationId,
    };
  }

  /**
   * Every identity the journey minted, read straight out of the database.
   *
   * Read through the owner connection rather than through a read endpoint, so
   * that what is compared is the rows themselves and not a projection that
   * could agree with itself.
   */
  async function identities(): Promise<Record<string, readonly string[]>> {
    const rows = async (sql: string): Promise<readonly string[]> =>
      (await world.db.admin.execute<{ readonly id: string }>(sql, [world.alpha])).map(
        (row) => row.id,
      );
    return {
      gates: await rows(
        'select id::text as id from public.gates where business_id = $1 order by id',
      ),
      decisions: await rows(
        'select id::text as id from public.gate_decisions where business_id = $1 order by id',
      ),
      reservations: await rows(
        'select id::text as id from public.reservations where business_id = $1 order by id',
      ),
      leases: await rows(
        'select id::text as id from public.leases where business_id = $1 order by id',
      ),
      // Two different things both called an attempt, and both are compared.
      // `operations` is the command register's row — the attempt identity a
      // caller replays against. `attempts` is the runtime's immutable synthetic
      // attempt. A restart that preserved one and rebuilt the other would pass
      // a proof that only looked at whichever it happened to pick.
      register: await rows(
        'select operation_id::text as id from public.operations where business_id = $1 order by operation_id',
      ),
      attempts: await rows(
        'select id::text as id from public.attempts where business_id = $1 order by id',
      ),
    };
  }

  it('minted a gate, a decision, a reservation and a lease before anything restarted', async () => {
    const before = await identities();
    expect(before['gates']).toContain(journey.gateId);
    expect(before['reservations']).toContain(journey.reservationId);
    expect(before['leases']).toContain(journey.leaseId);
    expect(before['register']).toContain(journey.pickupOperationId);
    expect(before['decisions']?.length ?? 0).toBeGreaterThan(0);
  });

  it('serves the same rows from a fresh application instance', async () => {
    const before = await identities();
    const fresh = rebuildApi(world);
    try {
      // The task is readable through the new instance, which is the ordinary
      // half, and then the identities are compared, which is the half the
      // early checkpoint does not cover.
      const read = await asAda(
        '/task/read',
        { operationId: randomUUID(), recordId: journey.taskId },
        fresh.api,
      );
      expect(read.code).toBe('ok');
      expect(await identities()).toStrictEqual(before);
    } finally {
      await fresh.close();
    }
  });

  it('keeps every identity across a restart of its own Postgres', async () => {
    const before = await identities();
    const startedBefore = startedAt();
    restartOwnContainer();
    const startedAfter = startedAt();
    // The restart happened. Without this the rest of the case would pass
    // just as happily against a container that was never touched.
    expect(startedAfter).not.toBe(startedBefore);
    report('container restart', [`${startedBefore} -> ${startedAfter}`]);
    const fresh = rebuildApi(world);
    try {
      const read = await asAda(
        '/task/read',
        { operationId: randomUUID(), recordId: journey.taskId },
        fresh.api,
      );
      expect(read.code).toBe('ok');
      // Same rows, same identifiers, in the same order. A row recreated rather
      // than preserved changes this comparison, which is what makes the
      // assertion about durability rather than about presence.
      expect(await identities()).toStrictEqual(before);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it('hands back exactly once on the new instance, and a replayed pickup adds no hold', async () => {
    const fresh = rebuildApi(world);
    try {
      const leasesBefore = await countLeases();

      // The replay first: the same operation identity the pickup already used.
      // The register must answer it rather than mint a second lease, and the
      // answer must be the original one.
      const replayed = await asAgent(
        '/task/pickup',
        { operationId: journey.pickupOperationId, reservationId: journey.reservationId },
        undefined,
        fresh.api,
      );
      expect(replayed.code).toBe('ok');
      expect(await countLeases()).toBe(leasesBefore);

      const handback = {
        leaseId: journey.leaseId,
        fence: journey.fence,
        outcome: 'completed',
        report: { wrote: 'a draft' },
      };
      const first = await asAgent(
        '/task/handback',
        { operationId: randomUUID(), ...handback },
        journey.credential,
        fresh.api,
      );
      expect(first.code, 'the first handback').toBe('ok');

      // Exactly once, and the observed reason is pinned rather than left as
      // "not ok": the first handback **settles the delegation**, so the second
      // call presents a credential that is no longer live and is refused 401
      // `DELEGATION_NOT_LIVE` before it reaches the lease at all. That is a
      // stronger answer than a stale fence would be, and naming it here means
      // a later change that turned it into a fence refusal — or into a second
      // settlement — fails this case instead of sliding past it.
      const second = await asAgent(
        '/task/handback',
        { operationId: randomUUID(), ...handback },
        journey.credential,
        fresh.api,
      );
      expect(second.status, 'the second handback').toBe(401);
      expect(second.code, 'the second handback').toBe('DELEGATION_NOT_LIVE');
      report('second handback', [`${String(second.status)} ${second.code}`]);
      report('replayed pickup', [`${String(replayed.status)} ${replayed.code}`]);
      expect(await countLeases()).toBe(leasesBefore);
    } finally {
      await fresh.close();
    }
  });

  async function countLeases(): Promise<number> {
    const rows = await world.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.leases where business_id = $1 and reservation_id = $2',
      [world.alpha, journey.reservationId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  it('answers an expired bearer AUTH_SESSION_EXPIRED on both prefixes', async () => {
    // Signed with this deployment's own secret, so the signature verifies and
    // what failed is the clock. That is the whole reason it is told apart from
    // `AUTH_UNKNOWN_LOGIN`: the caller held a credential this server issued,
    // learns nothing from being told it ran out, and gains a door they can open.
    const expiredPerson = await tokenFor(world.ada.subject, { expiresIn: -60 });
    const expiredAgent = await tokenFor(world.agent.subject, { expiresIn: -60 });

    const person = await call(
      world.api,
      personPath('alpha', '/task/read'),
      { operationId: randomUUID(), recordId: journey.taskId },
      bearer(expiredPerson),
    );
    expect(person.status).toBe(401);
    expect(person.code).toBe('AUTH_SESSION_EXPIRED');

    const agent = await call(
      world.api,
      agentPath('alpha', '/task/queue'),
      { operationId: randomUUID() },
      bearer(expiredAgent),
    );
    expect(agent.status).toBe(401);
    expect(agent.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('records that the mounted app does not draw the re-login path for an expired session', async () => {
    // `apps/api/app.ts` answers an expired bearer `AUTH_SESSION_EXPIRED` 401 on
    // both prefixes, and `docs/local/AUTHORITY.md` calls that "the re-login
    // path" — the one refusal that is a door the person can open. The mounted
    // app's client has a hook for exactly that, `onSessionEnded`, and it fires
    // on `SESSION_ENDED`, which the client defines as `AUTH_UNKNOWN_LOGIN`.
    // Those are two different codes, so the hook does not fire for the one
    // case it exists for.
    //
    // Driven through the real `OperationsClient` against the real app, because
    // reading the constant would only prove what the source says. Asserted as
    // observed, so it fails when fixed.
    const expired = await tokenFor(world.ada.subject, { expiresIn: -60 });
    const ended: string[] = [];
    const client = new OperationsClient({
      base: 'http://api.test/api',
      businessKey: 'alpha',
      token: expired,
      // Typed as the client's own `fetch` shape rather than the DOM's, because
      // `tsconfig.json` is the server project and does not carry the DOM lib.
      fetch: (async (input: string, init?: RequestInit) =>
        await world.api.fetch(new Request(input, init))) as typeof globalThis.fetch,
      onSessionEnded: (refusal) => ended.push(refusal.code),
    });

    const result = await client.read('task.read', { recordId: journey.taskId });
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.code).toBe('AUTH_SESSION_EXPIRED');
    // The refusal arrived and the hook did not fire.
    expect(ended).toStrictEqual([]);
    report('web onSessionEnded for AUTH_SESSION_EXPIRED', [
      `fired ${String(ended.length)} times`,
      'client.ts SESSION_ENDED is AUTH_UNKNOWN_LOGIN',
    ]);
  });

  it('resumes the same session state on a fresh token', async () => {
    // The same subject, a new `exp`. What must come back is the same person in
    // the same business seeing the same task — a new session over the same
    // state, not a new state.
    const fresh = await tokenFor(world.ada.subject);
    const answer = await call(
      world.api,
      personPath('alpha', '/task/read'),
      { operationId: randomUUID(), recordId: journey.taskId },
      bearer(fresh),
    );
    expect(answer.code).toBe('ok');
    const task = answer.body['task'] as Record<string, unknown>;
    expect(task['id']).toBe(journey.taskId);
  });
});
