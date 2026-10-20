// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the API process, the worker and the flow they share, kept in one place */
//
// The world #1623's TEST F5 proof runs in: one migrated database, the real
// API entry (`apps/api/server.ts`) started as its own OS process on a port this
// lane owns, and the shipped worker (`apps/worker/worker.ts`) talking to it over
// HTTP exactly as `apps/worker/main.ts` builds it, with `httpTransport`. The
// worker never opens the database (`worker.ts` header); only the test reads
// rows, on the administrative connection, to see what each step changed.
//
// Every process here is started by this file and stopped by its PID, after
// `ps` confirms the PID is still the API entry it started. Whatever a failed
// case leaves running, `useRestartWorld`'s afterAll stops. Each API process of
// one world shares the database, the gate key and one delegation keyring in a
// temporary folder, so a fresh process serves what the stopped one minted.
//
// Each case asks for an agent of its own: a pickup's delegation stays live
// after its effect is observed, and one agent holds one live delegation per
// purpose, so a second case on the same agent would be refused at pickup.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { httpTransport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { ensureCredentialKeyFile } from '../../packages/core-records/src/authority/credential-keys.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import {
  BUSINESS_KEY,
  createApiFixture,
  ISSUER,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { launchThrough, type HandedBack } from '../support/launch-worker.ts';
import { sharedKeySetUrl } from '../support/sign-in.ts';
import { COMPUTES_NOTHING } from '../support/computes-nothing-runner.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;
const ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = 'apps/api/server.ts';

/** The loopback ports this lane's API processes may bind, and no others. */
export const API_PORTS = { restarted: 54505, live: 54506 } as const;

type Name = Parameters<typeof pathOf>[0];

/** How a process ended, as its `exit` event gave it. */
export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ApiProcess {
  readonly pid: number;
  readonly origin: string;
  /** SIGTERM to this PID once `ps` shows it is still the API entry; resolves with its exit. */
  stop(): Promise<Exit>;
}

/** The world's live bindings, filled in by `useRestartWorld`. */
export const w = {} as { fixture: ApiFixture; keys: string; personToken: string };

const running = new Set<ApiProcess>();

/** Whether `origin` answers its health read. */
export async function answers(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/api/health`)).status === 200;
  } catch {
    return false;
  }
}

/** Whether `pid` is still a process running the API entry. */
function isTheApi(pid: number): boolean {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(ENTRY);
}

async function apiEnvironment(port: number): Promise<NodeJS.ProcessEnv> {
  const admin = new URL(databaseUrlFromEnvironment() as string);
  admin.pathname = `/${w.fixture.db.name}`;
  return {
    PATH: process.env['PATH'] ?? '',
    API_PORT: String(port),
    DATABASE_URL: w.fixture.db.appUrl,
    DATABASE_ADMIN_URL: admin.toString(),
    SUPABASE_KEY_SET_URL: await sharedKeySetUrl(),
    GOTRUE_URL: ISSUER,
    GATE_SIGNING_KEY_ID: w.fixture.environment.GATE_SIGNING_KEY_ID,
    GATE_SIGNING_SECRET: w.fixture.environment.GATE_SIGNING_SECRET,
    DELEGATION_CREDENTIAL_KEY_FILE: join(w.keys, 'delegation-keys.json'),
    // The fixture's one business, so start-time recovery and the sweep run on it.
    RECOVERY_BUSINESS_KEYS: BUSINESS_KEY,
  };
}

/** Polls `origin` until it answers or `gone` says the process has ended. */
async function awaitAnswer(origin: string, gone: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    // Polling one server, one probe at a time.
    // eslint-disable-next-line no-await-in-loop
    if (gone() || (await answers(origin))) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => {
      setTimeout(done, 100);
    });
  }
  return !gone() && (await answers(origin));
}

/** The production API entry as its own process on `port`, against the world's database. */
export async function startApi(port: number): Promise<ApiProcess> {
  const origin = `http://127.0.0.1:${String(port)}`;
  if (await answers(origin)) throw new Error(`something already answers on ${origin}`);
  const child: ChildProcess = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: await apiEnvironment(port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  const hear = (chunk: Buffer): void => {
    said = `${said}${chunk.toString('utf8')}`.slice(-4_000);
  };
  child.stdout?.on('data', hear);
  child.stderr?.on('data', hear);
  const pid = child.pid as number;
  console.log(`api-restart: started ${ENTRY} pid ${String(pid)} on ${origin}`);
  let ended: Exit | undefined;
  const exited = new Promise<Exit>((done) => {
    child.once('exit', (code, signal) => {
      ended = { code, signal };
      done(ended);
    });
  });
  const api: ApiProcess = {
    pid,
    origin,
    async stop() {
      if (ended === undefined && isTheApi(pid)) process.kill(pid, 'SIGTERM');
      const exit = await exited;
      running.delete(api);
      console.log(`api-restart: pid ${String(pid)} exited ${JSON.stringify(exit)}`);
      return exit;
    },
  };
  running.add(api);
  if (!(await awaitAnswer(origin, () => ended !== undefined))) {
    await api.stop();
    throw new Error(`the API process did not answer on ${origin}: ${said.trim()}`);
  }
  return api;
}

/** The fixture's person, through the person door of the API process at `origin`. */
export async function asPerson(origin: string, name: Name, body: object): Promise<Answer> {
  const response = await fetch(`${origin}/api/b/${BUSINESS_KEY}${pathOf(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${w.personToken}` },
    body: JSON.stringify({ operationId: randomUUID(), ...body }),
  });
  const text = await response.text();
  return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : { text } };
}

/** A fresh agent of the business, with a login of its own and its bearer. */
export interface Agent {
  readonly actorId: string;
  readonly token: string;
}

export async function newAgent(): Promise<Agent> {
  const { db, business, member } = w.fixture;
  const actorId = randomUUID();
  const subject = `agent-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      actorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, actorId, member.actorId],
    );
  });
  return { actorId, token: await tokenFor(subject) };
}

/**
 * The delegation the worker proposes under (`OPS_ASTRO_DELEGATION`), minted
 * under the keyring every API process of this world serves.
 */
async function proposerDelegation(agent: Agent, taskId: string): Promise<string> {
  const { db, business, member } = w.fixture;
  const keys = ensureCredentialKeyFile(join(w.keys, 'delegation-keys.json'));
  return await db.app.withBusiness(business, async (tx) => {
    const minted = await mintDelegation(
      tx,
      {
        agentActorId: agent.actorId,
        delegatePersonId: member.personId,
        mintedByActorId: member.actorId,
        purpose: `f5_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      keys,
    );
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

/** A worker with nothing kept, talking to the API at `origin` as `main.ts` builds it. */
export const workerAt = (
  origin: string,
  agent: Agent,
  delegation: string,
): ReturnType<typeof createWorker> =>
  createWorker({
    transport: httpTransport(origin),
    businessKey: BUSINESS_KEY,
    credential: agent.token,
    delegation,
    reporter: SYNTHETIC_USAGE,
    runner: COMPUTES_NOTHING,
  });

/** The owner's Launch decision D, as `task.decide` answered it. */
export interface Launch {
  readonly decisionId: string;
  readonly gateId: string;
  readonly versionId: string;
}

/**
 * Through the API at `origin`: a task, the worker's synthetic change proposed,
 * the plan accepted, the work handed back for review by the worker, and the
 * reviewed output launched by the person. Answers the launch decision.
 */
export async function launchedAt(
  origin: string,
  agent: Agent,
): Promise<{ taskId: string; delegation: string; handed: HandedBack; launch: Launch }> {
  const created = await asPerson(origin, 'task.create', {
    fields: { title: `f5 launch ${randomUUID()}` },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const taskId = String(created.body['recordId']);
  const delegation = await proposerDelegation(agent, taskId);
  const worker = workerAt(origin, agent, delegation);
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
  const read = await asPerson(origin, 'task.read', { recordId: taskId });
  const task = read.body['task'] as { proposals: { versions: { versionId: string }[] }[] };
  const accepted = await asPerson(origin, 'task.decide', {
    gateId: proposed.proposed.gateId,
    versionId: String(task.proposals[0]?.versions[0]?.versionId),
    decision: 'approve',
    note: 'accept the plan',
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const { handed, accepted: launched } = await launchThrough(worker, taskId, async (body) => {
    const answer = await asPerson(origin, 'task.decide', body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body['detail'] as Record<string, unknown>;
  });
  return {
    taskId,
    delegation,
    handed,
    launch: {
      decisionId: String(launched['decisionId']),
      gateId: String(launched['gateId']),
      versionId: String(launched['versionId']),
    },
  };
}

/**
 * Everything a claim, a dispatch, an effect or an observation would write,
 * read on the administrative connection: the task's leases and attempts, the
 * business's register and audit chain, and its comments.
 */
export async function footprint(taskId: string): Promise<string> {
  const [row] = await w.fixture.db.admin.execute<{ readonly state: string }>(
    `select jsonb_build_object(
        'leases', (select jsonb_agg(to_jsonb(l) order by l.fence) from public.leases l
                    where l.business_id = $1 and l.task_id = $2),
        'attempts', (select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
                       from public.attempts a
                       join public.reservations r on r.business_id = a.business_id
                                                 and r.id = a.reservation_id
                       join public.planned_runs run on run.business_id = r.business_id
                                                   and run.id = r.run_id
                      where a.business_id = $1 and run.task_id = $2),
        'operations', (select count(*) from public.operations where business_id = $1),
        'audit', (select count(*) from public.audit_events where business_id = $1),
        'records', (select count(*) from public.records where business_id = $1)
      )::text as state`,
    [w.fixture.business, taskId],
  );
  return String(row?.state);
}

/** The person's read of the attempt's receipt, through the API at `origin`. */
export async function receiptAt(
  origin: string,
  attemptId: string,
): Promise<Record<string, unknown>> {
  const answer = await asPerson(origin, 'task.receipt', { attemptId });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['receipt'] as Record<string, unknown>;
}

export function useRestartWorld(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.fixture = await createApiFixture(part);
    w.keys = mkdtempSync(join(tmpdir(), 'api-restart-keys-'));
    w.personToken = await tokenFor(w.fixture.member.presented.subject);
  }, 180_000);

  afterAll(async () => {
    for (const api of running) {
      // One at a time: each is stopped and seen to exit.
      // eslint-disable-next-line no-await-in-loop
      await api.stop();
    }
    if (w.keys !== undefined) rmSync(w.keys, { recursive: true, force: true });
    await w.fixture?.db.drop();
  });
}
