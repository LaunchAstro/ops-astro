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
import { dirname } from 'node:path';
import { expect } from 'vitest';
import {
  ADMIN_ACTIONS,
  ADMIN_COLLECTIONS,
  enrolAgent,
  enrolCaller,
  type AgentIdentity,
  type Caller,
} from './cast.ts';
import { agentPath, bearer, call, personPath, type World } from './world.ts';

/**
 * Where a measured count goes.
 *
 * The runner swallows stdout, and a count nobody can read is a count nobody
 * can quote. `.local/` is gitignored, so the evidence lands beside the run
 * rather than in the tree.
 */
export function report(label: string, lines: readonly string[]): void {
  // `pnpm verify:restart` names its own evidence file; a bare run keeps the old one.
  const file = process.env['L5_RESTART_EVIDENCE'] ?? '.local/l5-restart.txt';
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${label}: ${lines.join(', ')}\n`);
}

/**
 * The container a restart may touch: declared, then proved, never assumed.
 *
 * Hard-wiring one name made the case a guarded skip everywhere but the lane
 * that wrote it, so nobody could run the proof at the integrated head. The
 * name now comes from `L5_RESTART_CONTAINER_NAME`, and before anything is
 * restarted it has to clear two refusals. The deny list is checked first and
 * without a daemon call: the working slice's own database, the datafix
 * database and every `supabase_*` container are other people's servers, and a
 * restart aimed at one would stop their work. Then the daemon is asked which
 * host port the container publishes for 5432, and it must be the port in the
 * URL the suite is connected to — a declared name that is not the server
 * behind `DATABASE_URL` would restart one thing and prove another.
 *
 * A refusal is returned as its reason and the case fails with it. It is never
 * a skip: a proof that did not run must not read as one that passed.
 */
export const RESTART_CONTAINER_VARIABLE = 'L5_RESTART_CONTAINER_NAME';
const DENIED_NAMES: ReadonlySet<string> = new Set(['ops-astro-local-pg', 'ops-astro-datafix-pg']);
const DENIED_PREFIX = 'supabase_';
const DOCKER = '/usr/local/bin/docker';

export function refusalFor(
  name: string | undefined,
  databaseUrl: string | undefined,
  portOf: (name: string) => string | undefined,
): string | undefined {
  if (name === undefined || name === '') {
    return `no container is declared: set ${RESTART_CONTAINER_VARIABLE} to the one behind DATABASE_URL`;
  }
  if (DENIED_NAMES.has(name) || name.startsWith(DENIED_PREFIX)) {
    return `${name} is on the restart deny list and is never restarted by this proof`;
  }
  if (databaseUrl === undefined) return 'DATABASE_URL is unset, so no server can be matched';
  const urlPort = new URL(databaseUrl).port || '5432';
  const hostPort = portOf(name);
  if (hostPort === undefined) return `${name} has no published 5432 port the daemon can report`;
  if (hostPort !== urlPort) {
    return `${name} publishes ${hostPort} but DATABASE_URL is on ${urlPort}, so it is not this server`;
  }
  return undefined;
}

/** The host port the daemon reports for the container's 5432, or undefined. */
export function publishedPort(name: string): string | undefined {
  try {
    const port = execFileSync(
      DOCKER,
      [
        'inspect',
        name,
        '--format',
        '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return port === '' ? undefined : port;
  } catch {
    return undefined;
  }
}

/** The declared container, or a thrown refusal carrying its reason. */
export function declaredContainer(databaseUrl: string | undefined): string {
  const name = process.env[RESTART_CONTAINER_VARIABLE];
  const refusal = refusalFor(name, databaseUrl, publishedPort);
  if (refusal !== undefined) throw new Error(`restart refused: ${refusal}`);
  return name as string;
}

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
export function startedAt(container: string): string {
  return execFileSync(DOCKER, ['inspect', container, '--format', '{{.State.StartedAt}}'], {
    encoding: 'utf8',
  }).trim();
}

export function restartContainer(container: string): void {
  execFileSync(DOCKER, ['restart', container], { stdio: 'pipe' });
  // `docker restart` returns when the container is up, not when Postgres is
  // accepting connections. Waiting on the server's own readiness check rather
  // than on a sleep is what keeps this from being flaky on a slow machine.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      execFileSync(DOCKER, ['exec', container, 'pg_isready', '-q', '-U', 'postgres'], {
        stdio: 'pipe',
      });
      return;
    } catch {
      execFileSync('/bin/sleep', ['1'], { stdio: 'pipe' });
    }
  }
  throw new Error(`${container} did not accept connections after the restart`);
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
  /** The exact propose and decide requests, so a replay after a restart is byte-identical. */
  readonly proposeBody: Readonly<Record<string, unknown>>;
  readonly decideBody: Readonly<Record<string, unknown>>;
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
export async function walkTheJourney(
  world: World,
  options: { readonly pickup?: boolean } = {},
): Promise<Journey> {
  const created = await asAda(world, world.api, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a task that outlives a restart ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);

  const proposeBody = {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 3000,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  };
  const proposed = await asAda(world, world.api, '/task/propose', proposeBody);
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;

  const decideBody = {
    operationId: randomUUID(),
    gateId: detail['gateId'],
    versionId: detail['versionId'],
    decision: 'approve',
    note: 'approved so an agent can work it',
  };
  const decided = await asAda(world, world.api, '/task/decide', decideBody);
  expect(decided.code, 'decide').toBe('ok');
  const decision = decided.body['detail'] as Record<string, string>;

  const pickupOperationId = randomUUID();
  if (options.pickup === false) {
    return {
      taskId,
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      reservationId: String(decision['reservationId']),
      leaseId: '',
      fence: 0,
      credential: '',
      pickupOperationId,
      proposeBody,
      decideBody,
    };
  }
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
    proposeBody,
    decideBody,
  };
}

/**
 * The three other lineages W06 names, each left in the state a restart must
 * not change.
 *
 * `pending` is proposed and never decided: after a restart it must still have
 * no decision and no reservation, which is "no auto approval". `cancelled` is
 * approved, then cancelled the way a person cancels one, through the declared
 * `task.cancel` operation on the API, so a restart that resumed it would show
 * a live lineage or a claimable hold.
 * `settled` is walked to a handback before anything restarts, so the handback
 * report (the receipt) and the settled delegation cross the restart as rows
 * rather than being minted after it.
 */
export interface Lineages {
  readonly pendingGateId: string;
  readonly cancelledTaskId: string;
  readonly cancelledLineageId: string;
  readonly cancelledReservationId: string;
  readonly settledLeaseId: string;
}

async function lineageOf(world: World, versionId: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly id: string }>(
    'select lineage_id::text as id from public.proposal_versions where business_id = $1 and id = $2',
    [world.alpha, versionId],
  );
  return String(rows[0]?.id);
}

export async function walkTheOtherLineages(world: World): Promise<Lineages> {
  const created = await asAda(world, world.api, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a proposal nobody decides ${randomUUID()}` },
  });
  const taskId = String(created.body['recordId']);
  const pending = await asAda(world, world.api, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1000,
    currency: 'AUD',
    payload: { instruction: 'wait for a person' },
    step: { kind: 'compose', payload: {} },
  });
  expect(pending.code, 'propose, left undecided').toBe('ok');
  const pendingGateId = String((pending.body['detail'] as Record<string, string>)['gateId']);

  const toCancel = await walkTheJourney(world, { pickup: false });
  const cancelledLineageId = await lineageOf(world, toCancel.versionId);
  const cancelled = await asAda(world, world.api, '/task/cancel', {
    operationId: randomUUID(),
    recordId: toCancel.taskId,
    lineageId: cancelledLineageId,
    reason: 'w06',
  });
  expect([cancelled.status, cancelled.code], 'task.cancel').toStrictEqual([200, 'ok']);

  const toSettle = await walkTheJourney(world);
  const handedBack = await asAgent(
    world,
    world.api,
    '/task/handback',
    {
      operationId: randomUUID(),
      leaseId: toSettle.leaseId,
      fence: toSettle.fence,
      outcome: 'completed',
      report: { wrote: 'a draft before the restart' },
    },
    toSettle.credential,
  );
  expect(handedBack.code, 'handback before the restart').toBe('ok');
  return {
    pendingGateId,
    cancelledTaskId: toCancel.taskId,
    cancelledLineageId,
    cancelledReservationId: toCancel.reservationId,
    settledLeaseId: toSettle.leaseId,
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
  // Identity and state together, as `id:state`: an identifier kept while its
  // state moved (a pending gate approved, a cancelled lineage made live, a
  // settled delegation made live again) is the silent resumption W06 names,
  // and comparing identifiers alone would pass it.
  return {
    lineages: await rows(
      "select id::text || ':' || state as id from public.proposal_lineages where business_id = $1 order by id",
    ),
    versions: await rows(
      'select id::text as id from public.proposal_versions where business_id = $1 order by id',
    ),
    evidence: await rows(
      'select id::text as id from public.evidence_packs where business_id = $1 order by id',
    ),
    gates: await rows(
      "select id::text || ':' || state as id from public.gates where business_id = $1 order by id",
    ),
    decisions: await rows(
      'select id::text as id from public.gate_decisions where business_id = $1 order by id',
    ),
    reservations: await rows(
      "select id::text || ':' || state as id from public.reservations where business_id = $1 order by id",
    ),
    leases: await rows(
      "select id::text || ':' || state as id from public.leases where business_id = $1 order by id",
    ),
    delegations: await rows(
      `select id::text || ':' || case when settled_at is not null then 'settled'
              when revoked_at is not null then 'revoked' else 'live' end as id
         from public.delegations where business_id = $1 order by id`,
    ),
    receipts: await rows(
      'select id::text as id from public.handback_reports where business_id = $1 order by id',
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
      "select id::text || ':' || state as id from public.attempts where business_id = $1 order by id",
    ),
  };
}

/** An agent's live lease on a person's approved work, for I08 across the restart. */
export interface AgentWork {
  readonly approver: Caller;
  readonly agent: AgentIdentity;
  readonly taskId: string;
  readonly reservationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly delegationId: string;
  readonly credential: string;
}

/**
 * A person of their own who approves their own work, and an agent that picks
 * it up: `ada` stays untouched, because the other restart cases act as her
 * after the restart and I08 takes this person's only write grant away.
 */
export async function walkAgentWork(world: World, name: string): Promise<AgentWork> {
  const approver = await enrolCaller(world.db, world.alpha, 'alpha', name, {
    membership: true,
    actions: ADMIN_ACTIONS,
    collections: ADMIN_COLLECTIONS,
  });
  const agent = await enrolAgent(world.db, world.alpha, world.ada.actorId as string);
  const as = bearer(approver.token);
  const created = await call(
    world.api,
    personPath('alpha', '/task/create'),
    {
      operationId: randomUUID(),
      fields: { title: `work ${name} across a restart ${randomUUID()}` },
    },
    as,
  );
  const taskId = String(created.body['recordId']);
  const proposed = await call(
    world.api,
    personPath('alpha', '/task/propose'),
    {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(world, taskId),
      purpose: 'draft_the_reply',
      maximumMinor: 700,
      currency: 'AUD',
      payload: { instruction: 'work an agent holds across a restart' },
      step: { kind: 'compose', payload: {} },
    },
    as,
  );
  expect(proposed.code, `propose for ${name}`).toBe('ok');
  const gate = proposed.body['detail'] as Record<string, string>;
  const decided = await call(
    world.api,
    personPath('alpha', '/task/decide'),
    {
      operationId: randomUUID(),
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: `approved for ${name}`,
    },
    as,
  );
  expect(decided.code, `decide for ${name}`).toBe('ok');
  const reservationId = String(
    (decided.body['detail'] as Record<string, unknown>)['reservationId'],
  );
  const picked = await call(
    world.api,
    agentPath('alpha', '/task/pickup'),
    {
      operationId: randomUUID(),
      reservationId,
    },
    bearer(agent.token),
  );
  expect(picked.code, `pickup for ${name}`).toBe('ok');
  const detail = picked.body['detail'] as Record<string, unknown>;
  return {
    approver,
    agent,
    taskId,
    reservationId,
    leaseId: String(detail['leaseId']),
    fence: Number(detail['fence']),
    delegationId: String(detail['delegationId']),
    credential: String(detail['credential']),
  };
}

/** `grant.revoke`, by `ada` as grant manager, of every live task write the approver holds. */
export async function revokeWritesOf(world: World, approver: Caller): Promise<readonly string[]> {
  const grants = await world.db.admin.execute<{ readonly id: string }>(
    `select id::text as id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = 'task' and action = 'write' and revoked_at is null`,
    [world.alpha, approver.personId],
  );
  expect(grants.length, 'the approver holds exactly one write grant').toBe(1);
  for (const grant of grants) {
    // eslint-disable-next-line no-await-in-loop -- through the owning route, one at a time
    const revoked = await asAda(world, world.api, '/grant/revoke', {
      operationId: randomUUID(),
      grantId: grant.id,
    });
    expect(revoked.code, 'grant.revoke').toBe('ok');
  }
  return grants.map((grant) => grant.id);
}

/** Heartbeat or handback on the agent's own lease, with its own credential; a retry passes its operation id. */
export async function agentOnLease(
  api: World['api'],
  work: AgentWork,
  name: '/task/heartbeat' | '/task/handback',
  operationId: string = randomUUID(),
): ReturnType<typeof call> {
  const body =
    name === '/task/heartbeat'
      ? { operationId, leaseId: work.leaseId, fence: work.fence }
      : {
          operationId,
          leaseId: work.leaseId,
          fence: work.fence,
          outcome: 'completed',
          report: { wrote: 'after the loss and the restart' },
        };
  return await call(api, agentPath('alpha', name), body, {
    ...bearer(work.agent.token),
    'x-agent-delegation': work.credential,
  });
}

/** Lease, hold, delegation and report count: everything a refused agent call must not move. */
export async function leaseState(world: World, leaseId: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly v: string }>(
    `select concat_ws('|', l.state, l.expires_at::text, l.fence::text, res.state,
              coalesce(res.classified_cause, '-'), coalesce(d.revocation_cause, '-'),
              (d.revoked_at is not null)::text, (d.settled_at is not null)::text,
              (select count(*) from public.handback_reports hr
                where hr.business_id = l.business_id and hr.lease_id = l.id)::text) as v
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [world.alpha, leaseId],
  );
  return String(rows[0]?.v);
}

/**
 * The historical recorded transition RECOVERY-ENTRY's own proof uses: an
 * approved, unleased hold whose lineage is then marked rejected by a separate
 * statement, so the terminal transition is recorded and its classification is
 * not. Written openly as fixture state from before the owning operations
 * classified in the same transaction; a crash cannot split those today, and
 * this does not claim one did.
 */
export async function recordHistoricalRejection(world: World, versionId: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly id: string }>(
    'select lineage_id::text as id from public.proposal_versions where business_id = $1 and id = $2',
    [world.alpha, versionId],
  );
  const lineageId = String(rows[0]?.id);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `update public.proposal_lineages
          set state = 'rejected', terminal_reason = 'historical rejection', terminal_at = now()
        where business_id = $1 and id = $2`,
      [world.alpha, lineageId],
    );
  });
  return lineageId;
}

/** A hold's state and classification, for "classified once and not again". */
export async function holdState(world: World, reservationId: string): Promise<string> {
  const rows = await world.db.admin.execute<{ readonly v: string }>(
    `select concat_ws('|', state, held_minor::text, coalesce(classified_cause, '-'),
              coalesce(classified_cause_id::text, '-')) as v
       from public.reservations where business_id = $1 and id = $2`,
    [world.alpha, reservationId],
  );
  return String(rows[0]?.v);
}
