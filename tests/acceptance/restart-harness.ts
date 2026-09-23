// SPDX-License-Identifier: AGPL-3.0-only
//
// The journey item 5 restarts, and the machinery for restarting it.
//
// Split out of `restart-and-expiry.test.ts` because that file reached 436
// changed lines against this repository's 400-line per-file cap, which no
// waiver lifts. The repository's own answer to exactly this is SPEC section
// 6's T1h row — **split the file, not the change** — and it names the two
// things not to do: delete the comments that say why each assertion is the
// assertion, or add the file to the size gate's generated list. Neither was
// done. The cases stayed in the test file; the walk, the row reads and the
// container control came here.
//
// Nothing in this file asserts anything about the product. It builds the state
// the cases interrogate and reads rows back, so a failure here is a broken
// fixture and a failure there is a finding.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { agentPath, bearer, call, personPath, type World } from './world.ts';

/**
 * Where a measured count goes.
 *
 * The runner swallows stdout, and a count nobody can read is a count nobody
 * can quote. `.local/` is gitignored, so the evidence lands beside the run
 * rather than in the tree.
 */
export function report(label: string, lines: readonly string[]): void {
  mkdirSync('.local', { recursive: true });
  appendFileSync('.local/l5-restart.txt', `${label}: ${lines.join(', ')}\n`);
}

/**
 * The lane's own container, named as a constant and never derived.
 *
 * The briefs for this round name several Postgres containers on one host, and
 * a restart aimed at the wrong one would stop somebody else's work. This is
 * the only container this lane starts, restarts or removes.
 */
export const CONTAINER = 'ops-astro-l5-pg';
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
export function startedAt(): string {
  return execFileSync(DOCKER, ['inspect', CONTAINER, '--format', '{{.State.StartedAt}}'], {
    encoding: 'utf8',
  }).trim();
}

export function restartOwnContainer(): void {
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

export interface Journey {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
  readonly pickupOperationId: string;
}

/** A call on the person prefix as `ada`, against whichever instance is given. */
export const asAda = async (
  world: World,
  api: World['api'],
  name: string,
  body: Readonly<Record<string, unknown>>,
): ReturnType<typeof call> =>
  await call(api, personPath('alpha', name), body, bearer(world.ada.token));

/** A call on the agent prefix, with the delegation credential beside it. */
export const asAgent = async (
  world: World,
  api: World['api'],
  name: string,
  body: Readonly<Record<string, unknown>>,
  credential?: string,
): ReturnType<typeof call> =>
  await call(api, agentPath('alpha', name), body, {
    ...bearer(world.agent.token),
    ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
  });

export async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

export async function countLeases(world: World, reservationId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.leases where business_id = $1 and reservation_id = $2',
    [world.alpha, reservationId],
  );
  return Number(rows[0]?.n ?? '0');
}

/** propose → decide → pickup, as a person and then as the agent. */
export async function walkTheJourney(world: World): Promise<Journey> {
  const created = await asAda(world, world.api, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a task that outlives a restart ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);

  const proposed = await asAda(world, world.api, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 3000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;

  const decided = await asAda(world, world.api, '/task/decide', {
    operationId: randomUUID(),
    gateId: detail['gateId'],
    versionId: detail['versionId'],
    decision: 'approve',
    note: 'approved so an agent can work it',
  });
  expect(decided.code, 'decide').toBe('ok');
  const decision = decided.body['detail'] as Record<string, string>;

  const pickupOperationId = randomUUID();
  const pickedUp = await asAgent(world, world.api, '/task/pickup', {
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
 * that what is compared is the rows themselves and not a projection that could
 * agree with itself.
 */
export async function identities(world: World): Promise<Record<string, readonly string[]>> {
  const rows = async (sql: string): Promise<readonly string[]> =>
    (await world.db.admin.execute<{ readonly id: string }>(sql, [world.alpha])).map(
      (row) => row.id,
    );
  return {
    gates: await rows('select id::text as id from public.gates where business_id = $1 order by id'),
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
    // attempt. A restart that preserved one and rebuilt the other would pass a
    // proof that only looked at whichever it happened to pick.
    register: await rows(
      'select operation_id::text as id from public.operations where business_id = $1 order by operation_id',
    ),
    attempts: await rows(
      'select id::text as id from public.attempts where business_id = $1 order by id',
    ),
  };
}
