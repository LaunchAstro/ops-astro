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
// that held the rows is not the server process that serves them afterwards. A
// test that only did (i) would prove the application forgets; a test that only
// did (ii) would let a warm pool answer from a cache. Both, in that order, is
// the claim.
//
// **Identity, not merely presence.** "The task is still there" is the early
// checkpoint and it is not this. Every identifier minted before the restart is
// read back afterwards and compared, so a row that was recreated rather than
// preserved fails here — which is exactly the silent resumption W06 names.
//
// The walk, the row reads and the container control are in
// `restart-harness.ts`; this file is the cases. See that file's head for why.

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
import {
  asAda,
  asAgent,
  countLeases,
  identities,
  report,
  restartOwnContainer,
  startedAt,
  walkTheJourney,
  type Journey,
} from './restart-harness.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/restart: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('restart and session expiry', () => {
  let world: World;
  let journey: Journey;

  beforeAll(async () => {
    world = await createWorld('rst');
    journey = await walkTheJourney(world);
  }, 180_000);

  afterAll(async () => {
    await world?.close();
  });

  it('minted a gate, a decision, a reservation and a lease before anything restarted', async () => {
    const before = await identities(world);
    expect(before['gates']).toContain(journey.gateId);
    expect(before['reservations']).toContain(journey.reservationId);
    expect(before['leases']).toContain(journey.leaseId);
    expect(before['register']).toContain(journey.pickupOperationId);
    expect(before['decisions']?.length ?? 0).toBeGreaterThan(0);
  });

  it('serves the same rows from a fresh application instance', async () => {
    const before = await identities(world);
    const fresh = rebuildApi(world);
    try {
      // The task is readable through the new instance, which is the ordinary
      // half, and then the identities are compared, which is the half the
      // early checkpoint does not cover.
      const read = await asAda(world, fresh.api, '/task/read', {
        operationId: randomUUID(),
        recordId: journey.taskId,
      });
      expect(read.code).toBe('ok');
      expect(await identities(world)).toStrictEqual(before);
    } finally {
      await fresh.close();
    }
  });

  // The one case that cannot share a Postgres server with anything else.
  //
  // Restarting the container terminates every connection on it, including the
  // ones the sibling acceptance suites hold, and they then fail with
  // `terminating connection due to administrator command` for a reason that
  // says nothing about the product. Vitest runs files in parallel and its
  // `fileParallelism` lives in `vitest.config.ts`, which this lane does not
  // own, so the case asks to be run rather than assuming it may.
  //
  // It is `skipIf` rather than a silent branch on purpose: a skipped case is
  // printed as skipped, and a proof nobody ran must never read as a proof that
  // passed. `docs/local/PROOFS.md` carries the command and the measured
  // evidence from the runs that did execute it.
  const restartAsked = process.env['L5_RESTART_CONTAINER'] === '1';

  it.skipIf(!restartAsked)(
    'keeps every identity across a restart of its own Postgres',
    async () => {
      const before = await identities(world);
      const startedBefore = startedAt();
      restartOwnContainer();
      const startedAfter = startedAt();
      // The restart happened. Without this the rest of the case would pass
      // just as happily against a container that was never touched.
      expect(startedAfter).not.toBe(startedBefore);
      report('container restart', [`${startedBefore} -> ${startedAfter}`]);
      const fresh = rebuildApi(world);
      try {
        const read = await asAda(world, fresh.api, '/task/read', {
          operationId: randomUUID(),
          recordId: journey.taskId,
        });
        expect(read.code).toBe('ok');
        // Same rows, same identifiers, in the same order. A row recreated rather
        // than preserved changes this comparison, which is what makes the
        // assertion about durability rather than about presence.
        expect(await identities(world)).toStrictEqual(before);
      } finally {
        await fresh.close();
      }
    },
    120_000,
  );

  it('hands back exactly once on the new instance, and a replayed pickup adds no hold', async () => {
    const fresh = rebuildApi(world);
    try {
      const leasesBefore = await countLeases(world, journey.reservationId);

      // The replay first: the same operation identity the pickup already used.
      // The register must answer it rather than mint a second lease, and the
      // answer must be the original one.
      const replayed = await asAgent(
        world,
        fresh.api,
        '/task/pickup',
        { operationId: journey.pickupOperationId, reservationId: journey.reservationId },
        undefined,
      );
      expect(replayed.code).toBe('ok');
      expect(await countLeases(world, journey.reservationId)).toBe(leasesBefore);

      const handback = {
        leaseId: journey.leaseId,
        fence: journey.fence,
        outcome: 'completed',
        report: { wrote: 'a draft' },
      };
      const first = await asAgent(
        world,
        fresh.api,
        '/task/handback',
        { operationId: randomUUID(), ...handback },
        journey.credential,
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
        world,
        fresh.api,
        '/task/handback',
        { operationId: randomUUID(), ...handback },
        journey.credential,
      );
      expect(second.status, 'the second handback').toBe(401);
      expect(second.code, 'the second handback').toBe('DELEGATION_NOT_LIVE');
      report('second handback', [`${String(second.status)} ${second.code}`]);
      report('replayed pickup', [`${String(replayed.status)} ${replayed.code}`]);
      expect(await countLeases(world, journey.reservationId)).toBe(leasesBefore);
    } finally {
      await fresh.close();
    }
  });

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

  it('draws the re-login path for an expired session, through the real client', async () => {
    // `apps/api/app.ts` answers an expired bearer `AUTH_SESSION_EXPIRED` 401 on
    // both prefixes, and `docs/local/AUTHORITY.md` calls that "the re-login
    // path" — the one refusal that is a door the person can open. The mounted
    // app's client has a hook for exactly that, `onSessionEnded`.
    //
    // At `b15ed7e` this case recorded a defect: `SESSION_ENDED` was
    // `AUTH_UNKNOWN_LOGIN` alone, so the hook fired zero times for the one
    // refusal it exists for, and the case asserted that zero *as observed* so
    // that it would fail on the day it was fixed. It has been fixed —
    // `apps/web/src/operations/client.ts:259` now carries both codes — and
    // this is that failure, turned round. The assertion is now the behaviour:
    // the hook fires once, with the code the server really sent.
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
    // The refusal arrived and the hook fired for it, once, carrying the code
    // rather than a flag — so the screen can tell an expired session from a
    // bearer the server cannot place at all, which is the distinction the two
    // codes exist to make.
    expect(ended).toStrictEqual(['AUTH_SESSION_EXPIRED']);
    report('web onSessionEnded for AUTH_SESSION_EXPIRED', [
      `fired ${String(ended.length)} times`,
      'client.ts SESSION_ENDED carries AUTH_UNKNOWN_LOGIN and AUTH_SESSION_EXPIRED',
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
