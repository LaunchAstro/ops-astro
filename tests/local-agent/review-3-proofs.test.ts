// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859), Opus review 3's proofs (R/local-agent/REVIEW-3.md), for range
// 77e317bd3..fb234b36e. Apply unchanged as tests/local-agent/review-3-proofs.test.ts.
// The two unit proofs run anywhere; the three database proofs skip without a
// database. No assertion prints a key. Made-up data only.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it as vitestIt } from 'vitest';
import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import {
  connect,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { APPROVAL_PURPOSE } from '../../apps/local-agent/approval.ts';
import type { GateSettings } from '../../apps/local-agent/gate.ts';
import { identityFromSeed, localIdentity } from '../../apps/local-agent/seed.ts';
import { readApiEnv, startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { runQueuedTasks } from '../../apps/local-agent/tick.ts';
import { localGate, tickSettings } from '../../apps/local-agent/tick-main.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  approve,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  rows,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { makeWorld, type World } from './world.ts';

const BUSINESS = '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
const SUBJECT = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const WORKER = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;
const quiet = (): void => {};

const worlds: World[] = [];
let stack: Stack | undefined;

const world = (): World => {
  const made = makeWorld();
  worlds.push(made);
  return made;
};

afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

afterAll(() => {
  for (const made of worlds) made.remove();
});

// ---------------------------------------------------------------- unit proofs

vitestIt(
  "Sol proof, criterion 7: the tick started from api.env, as the docs say, gates on the runner's own home and cap",
  async () => {
    const laptop = world();
    const started = await startStack(
      { ...laptop.env, OPS_LOCAL_AGENT_CAP_USD: '5' },
      laptop.userHome,
      quiet,
    );
    if (!started.ok) throw new Error(`stack refused: ${started.code}`);
    stack = started.stack;
    // The tick's terminal (docs/local/LOCAL-AGENT.md step 3): api.env sourced,
    // .local/db.env exported, and the tick's identity named.
    const tickEnv = {
      ...readApiEnv(readFileSync(stack.apiEnvFile, 'utf8')),
      DATABASE_URL: 'postgres://127.0.0.1:54390/ops_astro_local',
      OPS_LOCAL_AGENT_BUSINESS_ID: BUSINESS,
      OPS_LOCAL_AGENT_AGENT_SUBJECT: SUBJECT,
      OPS_LOCAL_AGENT_WORKER_ACTOR_ID: WORKER,
    };
    const read = tickSettings(tickEnv);
    expect(read.ok ? read.settings.gate : read.code).toMatchObject({
      home: stack.home,
      capUsd: 5,
      capConfigured: true,
    });
  },
);

vitestIt(
  "Sol proof, fence local only: the stack's seed lookup opens no database that is not on this machine",
  async () => {
    const laptop = world();
    writeFileSync(
      join(laptop.root, 'synthetic-agents.json'),
      JSON.stringify([{ business: 'alpha', email: 'agent-alpha@example.test', subject: SUBJECT }]),
    );
    const hosted = 'postgres://db.hosted.example.test:5432/ops_astro';
    const read = await identityFromSeed({
      OPS_ENVIRONMENT: 'local',
      OPS_LOCAL_AGENT_BUSINESS: 'alpha',
      OPS_SEED_DIR: laptop.root,
      DATABASE_URL: hosted,
      DATABASE_ADMIN_URL: hosted,
    }).catch((error: unknown) => ({ ok: `it tried to connect: ${String(error)}` }));
    expect(read).toMatchObject({ ok: false });
  },
  60_000,
);

// ------------------------------------------------------------ database proofs

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('la1review3', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** The broker's answer when the runner refused: released, with no reason the tick can read. */
const released: ModelCallExecutor = async () =>
  await Promise.resolve({
    command: 'model.call',
    recordId: null,
    revision: null,
    detail: { callId: randomUUID(), state: 'released', outcome: 'CALL_RELEASED' },
  } as Awaited<ReturnType<ModelCallExecutor>>);

/** One approved piece of work in a business of its own, run once by the tick under the gate. */
async function tickAtCap(
  part: string,
  settings: GateSettings,
): Promise<{ readonly taskId: string; readonly pass: unknown; readonly asks: number }> {
  const b = await seedSchedules(s.db, part, 1_000_000);
  const taskId = await createTask(b, `Local cap ${randomUUID().slice(0, 8)}`);
  await approve(b, await propose(b, taskId, { maximumMinor: 2_000, purpose: freshPurpose() }));
  const gate = localGate(
    {
      environment: LOCAL,
      database: b.db.app,
      businessId: b.business,
      agent: b.agent,
      home: settings.home,
    },
    settings,
  );
  const pass = await runQueuedTasks({
    environment: LOCAL,
    database: b.db.app,
    businessId: b.business,
    agent: b.agent,
    executeModelCall: released,
    operation: 'model.local_claude_compose',
    fieldsFor: () => [],
    gate,
  });
  const [count] = await rows<{ n: string }>(
    b,
    `select count(*)::text as n
       from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and g.state = 'pending' and v.purpose = $2`,
    [b.business, APPROVAL_PURPOSE],
  );
  return { taskId, pass, asks: Number(count?.n ?? 0) };
}

it('Sol proof, criterion 7: at a cap the owner configured, the tick asks for no yes that cannot raise it', async () => {
  const laptop = world();
  laptop.write('ledger.jsonl', `${JSON.stringify({ costUsd: 10 })}\n`);
  const ran = await tickAtCap('la1r3configured', {
    home: laptop.agentHome,
    capUsd: 10,
    capConfigured: true,
  });
  expect(ran.pass).toMatchObject({
    ok: true,
    ran: [{ taskId: ran.taskId, outcome: 'refused', refusal: { code: 'LOCAL_CAP_REACHED' } }],
  });
  // OPS_LOCAL_AGENT_CAP_USD is the cap whatever approvals.json says: a yes changes nothing.
  expect(ran.asks).toBe(0);
}, 120_000);

it('Sol proof, criterion 7: at the USD 30 ceiling, the tick asks for no yes that cannot raise it', async () => {
  const laptop = world();
  laptop.write('approvals.json', { capUsd: 30, models: [] });
  laptop.write('ledger.jsonl', `${JSON.stringify({ costUsd: 30 })}\n`);
  const ran = await tickAtCap('la1r3ceiling', {
    home: laptop.agentHome,
    capUsd: 10,
    capConfigured: false,
  });
  expect(ran.pass).toMatchObject({
    ok: true,
    ran: [{ taskId: ran.taskId, outcome: 'refused', refusal: { code: 'LOCAL_CAP_REACHED' } }],
  });
  // The cap is already the owner's ceiling: a yes on "raise to USD 30" changes nothing.
  expect(ran.asks).toBe(0);
}, 120_000);

/** The agent's actor, login and mapping, as scripts/local-seed.mjs writes them. */
async function seedAgent(app: Database, businessId: string, subject: string): Promise<void> {
  await app.withBusiness(businessId as BusinessId, async (tx) => {
    const actorId = randomUUID();
    const loginId = randomUUID();
    await tx.query(
      `insert into public.actors (business_id, id, kind, active) values ($1, $2, 'agent', true)`,
      [businessId, actorId],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
      [businessId, loginId, subject],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $4)`,
      [businessId, randomUUID(), loginId, actorId],
    );
  });
}

/** Both parties meet here, or the one that waits goes on after `waitMs` (a lock in the fix). */
function meeting(parties: number, waitMs: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = quiet;
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await Promise.race([
      everyone,
      new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      }),
    ]);
  };
}

/** The same database, but each transaction waits at the meeting once it has looked for a worker. */
function meetAfterWorkerRead(real: Database, meet: () => Promise<void>): Database {
  return {
    log: real.log,
    close: async () => {
      await real.close();
    },
    withBusiness: async (businessId, run) =>
      await real.withBusiness(
        businessId,
        async (tx) =>
          await run({
            businessId: tx.businessId,
            query: async <Row>(text: string, parameters?: readonly unknown[]) => {
              const result = await tx.query<Row>(text, parameters);
              if (/^\s*select/iu.test(text) && /kind = 'worker'/u.test(text)) await meet();
              return result;
            },
          } as TenantQuery),
      ),
  };
}

it('Sol proof, idempotence: two stacks starting together make the business one worker, not two', async () => {
  const key = 'la1r3seed';
  const businessId = await insertBusiness(s.db.app, key);
  const subject = randomUUID();
  await seedAgent(s.db.app, businessId, subject);
  const meet = meeting(2, 3_000);
  const first = connect(s.db.appUrl, { source: 'runtime' });
  const second = connect(s.db.appUrl, { source: 'runtime' });
  try {
    const [a, b] = await Promise.all([
      localIdentity({ admin: s.db.admin, app: meetAfterWorkerRead(first, meet) }, key, subject),
      localIdentity({ admin: s.db.admin, app: meetAfterWorkerRead(second, meet) }, key, subject),
    ]);
    const workers = await s.db.admin.execute<{ id: string }>(
      `select id from public.actors where business_id = $1 and kind = 'worker' and active`,
      [businessId],
    );
    expect(workers).toHaveLength(1);
    expect(a.ok && b.ok && a.identity.workerActorId === b.identity.workerActorId).toBe(true);
  } finally {
    await first.close();
    await second.close();
  }
}, 120_000);
