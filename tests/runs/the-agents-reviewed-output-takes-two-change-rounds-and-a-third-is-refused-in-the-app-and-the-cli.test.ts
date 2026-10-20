// SPDX-License-Identifier: AGPL-3.0-only
//
// #1738, criterion 1 (U103's AW-09 round on the new runner): the shipped
// worker computes the owner's accepted plan with `agentRunner` on the replay
// provider and hands its output back for review. On that output the owner
// asks for changes twice, the agent revising on the lineage after each, and
// a third ask is refused CHANGE_ROUNDS_EXHAUSTED, offering approve, reject or
// escalate, with the gate left open. The app's leg is the page's own client
// over the real door, and the story its gate card draws offers escalate in
// the place of request changes; the command line's leg is its own entry against the door
// served on loopback. The facts are compared whole across the two legs.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { main } from '../../apps/cli/main.ts';
import { SYNTHETIC_STEP } from '../../apps/worker/worker.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { CHANGE_ROUNDS, runStories } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { tokenFor } from '../api/fixture.ts';
import { rows } from '../runtime/schedules-harness.ts';
import { shippedBroker, shippedPlan } from './agent-drop-world.ts';
import { door, noDatabase, s, useStopWorld } from './run-stop-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('u103round');

type Leg = 'app' | 'cli';

/** A revision's ceiling: under the plan's envelope less what its compute spent. */
const REVISION_MINOR = 1_000;
interface Said {
  readonly ok: boolean;
  readonly code: string | null;
  readonly fixes: string;
}
interface At {
  readonly gateId: string;
  readonly versionId: string;
}

let server: ServerType | undefined;
let origin: string;
let key: string;
let scratch: string;
let owner: string;

beforeAll(async () => {
  if (noDatabase) return;
  const api = door(s.db.app, shippedBroker());
  server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((done) => {
    server?.once('listening', () => done());
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const [business] = await rows<{ key: string }>(
    s,
    'select key from public.businesses where id = $1',
    [s.business],
  );
  key = String(business?.key);
  scratch = mkdtempSync(join(tmpdir(), 'u103-round-'));
  owner = await tokenFor(s.decider.presented.subject);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => {
    if (server === undefined) done();
    else server.close(() => done());
  });
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

const saidOf = (ok: boolean, body: Record<string, unknown>): Said => ({
  ok,
  code: typeof body['code'] === 'string' ? body['code'] : null,
  fixes: String(body['fixes'] ?? ''),
});

/** The owner's page client over the served door. */
const page = (): OperationsClient =>
  new OperationsClient({
    origin,
    businessKey: key,
    signedIn: true,
    fetch: async (url, init) =>
      await fetch(url, {
        ...init,
        headers: { ...init?.headers, authorization: `Bearer ${owner}` },
      }),
  });

/** The owner's decision on `at`, the way the leg sends it. */
async function decide(leg: Leg, at: At, decision: string): Promise<Said> {
  const body = { gateId: at.gateId, versionId: at.versionId, decision, note: `u103 ${decision}` };
  if (leg === 'app') {
    const result = await page().mutate('task.decide', body);
    return 'ok' in result
      ? saidOf(true, {})
      : saidOf(false, result as unknown as Record<string, unknown>);
  }
  const out: string[] = [];
  const code = await main(
    ['task.decide', '--json', JSON.stringify(body)],
    {
      OPS_ASTRO_API_URL: origin,
      OPS_ASTRO_BUSINESS: key,
      OPS_ASTRO_TOKEN: owner,
      OPS_ASTRO_TOKEN_FILE: join(scratch, `token-${randomUUID()}`),
      OPS_ASTRO_DELEGATION_FILE: join(scratch, `delegation-${randomUUID()}`),
    },
    {
      out: (line) => out.push(line),
      err: (line) => out.push(line),
      stdin: async () => await Promise.resolve(''),
    },
  );
  return saidOf(code === 0, JSON.parse(out.join('\n') || '{}') as Record<string, unknown>);
}

/** A delegation for the agent's revisions on `taskId`, narrowed from the owner's grants. */
const revisions = async (taskId: string): Promise<string> =>
  await s.db.app.withBusiness(s.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: s.agentActorId,
      delegatePersonId: s.decider.personId,
      mintedByActorId: s.decider.actorId,
      purpose: `u103_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`setup: mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });

/** The agent's next version of its output on the lineage, through the agent door, or its refusal's status. */
async function revise(taskId: string, of: At, delegation: string): Promise<At | number> {
  const [version] = await rows<Record<string, unknown>>(
    s,
    `select v.lineage_id, v.purpose, v.currency,
            (select revision::int from public.records r where r.business_id = v.business_id and r.id = $3) as revision
       from public.proposal_versions v where v.business_id = $1 and v.id = $2`,
    [s.business, of.versionId, taskId],
  );
  const agent = await tokenFor(s.agent.subject);
  const response = await fetch(`${origin}/api/a/b/${key}/task/propose`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${agent}`,
      [DELEGATION_HEADER]: delegation,
    },
    body: JSON.stringify({
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: version?.['revision'],
      lineageId: version?.['lineage_id'],
      purpose: version?.['purpose'],
      // Within what the plan's envelope has left after the agent's turn.
      maximumMinor: REVISION_MINOR,
      currency: version?.['currency'],
      payload: { change: `revised ${randomUUID().slice(0, 8)}` },
      step: SYNTHETIC_STEP,
    }),
  });
  if (!response.ok) return response.status;
  const answer = (await response.json()) as { detail?: Record<string, unknown> };
  return {
    gateId: String(answer.detail?.['gateId']),
    versionId: String(answer.detail?.['versionId']),
  };
}

/**
 * What the owner's gate card offers on the task's current output: past
 * `CHANGE_ROUNDS`, escalate in the place of request changes, beside approve
 * (`surfaces/agent/gate.tsx`, GateControls).
 */
async function cardOffers(taskId: string): Promise<readonly string[]> {
  const read = await page().read('task.read', { recordId: taskId });
  if (!('ok' in read)) throw new Error(`task.read refused ${JSON.stringify(read)}`);
  const task = (read.value as { task?: { proposals?: readonly RunLineage[] } }).task;
  const story = runStories(task?.proposals).find((one) => one.gate.kind === 'armed');
  if (story === undefined || story.gate.kind === 'none') return [];
  return [story.gate.round > CHANGE_ROUNDS ? 'escalate' : 'request_changes', 'approve'];
}

async function round(leg: Leg) {
  const seam = await shippedPlan(`u103 round ${leg}`);
  const output = await seam.worker.applyOnce(seam.taskId);
  if (!('handedBack' in output)) throw new Error(`no output to review: ${JSON.stringify(output)}`);
  const turns = seam.log.filter((sent) => sent.verb === 'model.call');
  const delegation = await revisions(seam.taskId);
  const firstCard = await cardOffers(seam.taskId);
  const asks: (string | null)[] = [];
  let third: Said | undefined;
  let at: At = output.handedBack;
  for (let ask = 0; ask < 3; ask += 1) {
    // eslint-disable-next-line no-await-in-loop -- each round decides the version before it
    const said = await decide(leg, at, 'request_changes');
    asks.push(said.ok ? 'applied' : said.code);
    if (said.ok) {
      // eslint-disable-next-line no-await-in-loop -- the agent revises after each ask
      const next = await revise(seam.taskId, at, delegation);
      if (typeof next === 'number') {
        asks.push(`revision ${String(next)}`);
        break;
      }
      at = next;
    } else third = said;
  }
  const [gate] = await rows<Record<string, unknown>>(
    s,
    'select state, round from public.gates where business_id = $1 and id = $2',
    [s.business, at.gateId],
  );
  return {
    turns: turns.map(({ status, body }) => ({ status, operation: body['operation'] })),
    firstCard,
    asks,
    offers: /approve.*reject.*escalate/isu.test(third?.fixes ?? ''),
    gate,
    lastCard: await cardOffers(seam.taskId),
  };
}

it("the agent's reviewed output on the new runner takes two change rounds, and a third is refused in the app and the CLI", async () => {
  const app = await round('app');
  expect(app).toEqual({
    turns: [{ status: 200, operation: 'model.agent_turn' }],
    firstCard: ['request_changes', 'approve'],
    asks: ['applied', 'applied', 'CHANGE_ROUNDS_EXHAUSTED'],
    offers: true,
    gate: { state: 'pending', round: 3 },
    lastCard: ['escalate', 'approve'],
  });
  expect(await round('cli')).toEqual(app);
}, 300_000);
