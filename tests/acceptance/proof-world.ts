// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the process proofs share (T3d2's `runtime-proofs.test.tsx`,
// T3e1's `drop-proofs.test.tsx`): the acceptance world's two businesses, the
// harness's own admin connection, and ada's calls, work and workers over HTTP
// to the API process on `L5_RESTART_API_PORT`. Kept apart so each proof file
// stays under the per-file cap. It starts, calls and reads; it asserts only
// that a call ada makes is answered.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { httpTransport } from '../../apps/cli/client.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import type { AgentIdentity } from './cast.ts';
import { startWorker, type WorkerProcess } from './kill-harness.ts';
import { startApi, type RunningApi } from './restart-process.ts';
import { createWorld, serverUrl, type World } from './world.ts';

export const PROOF_PORT: string | undefined = process.env['L5_RESTART_API_PORT'];
/** Asked only by `pnpm verify:runtime-proofs`, on its own Postgres. */
export const PROOFS_ASKED: boolean =
  serverUrl !== undefined && process.env['L5_RUNTIME_PROOFS'] === '1' && !!PROOF_PORT;

type Name = Parameters<typeof pathOf>[0];
export const origin = (): string => `http://127.0.0.1:${String(PROOF_PORT)}`;

export interface Work {
  readonly taskId: string;
  readonly delegation: string;
  readonly decisionId: string;
  readonly token: string;
}

export interface ProofWorld {
  readonly world: World;
  readonly admin: AdminConnection;
  asAda(name: Name, body: object): Promise<Record<string, unknown>>;
  api(label: string): Promise<RunningApi & { readonly appName: string }>;
  approvedWork(agent: AgentIdentity): Promise<Work>;
  worker(
    w: Work,
    parkAt: string,
    name: string,
    leaseSeconds?: number,
    fault?: string,
  ): WorkerProcess;
  /** Applied effects on the task: the effect counter. */
  effects(taskId: string): Promise<number>;
  attempts(
    taskId: string,
  ): Promise<readonly { id: string; state: string; drop_cause: string | null }[]>;
  close(): Promise<void>;
}

export async function openProofWorld(part: string): Promise<ProofWorld> {
  const world = await createWorld(part);
  const url = new URL(serverUrl as string);
  url.pathname = `/${world.db.name}`;
  const admin = connectAsAdmin(url.toString());
  // Top-ups of one hold go through on ada alone (T2e's band), as T3d1's harness sets it.
  await admin.execute(
    `update public.business_settings set value = '100000'::jsonb
      where business_id = $1 and key = 'four_eyes_threshold'`,
    [world.alpha],
  );
  const live: { readonly pid: number; exited(): Promise<NodeJS.Signals | null> }[] = [];

  const asAda = async (name: Name, body: object): Promise<Record<string, unknown>> => {
    const answer = await fetch(`${origin()}/api/b/alpha${pathOf(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${world.ada.token}` },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    });
    const parsed = (await answer.json()) as Record<string, unknown>;
    expect(answer.status, `${name}: ${JSON.stringify(parsed)}`).toBe(200);
    return parsed;
  };

  /** A task, the agent's delegation to it, the worker's proposal and ada's approval, all over HTTP. */
  const approvedWork = async (agent: AgentIdentity): Promise<Work> => {
    const created = await asAda('task.create', { fields: { title: `${part} ${randomUUID()}` } });
    const taskId = String(created['recordId']);
    const delegation = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: agent.actorId,
        delegatePersonId: world.ada.personId as string,
        mintedByActorId: world.ada.actorId as string,
        purpose: `${part}_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    const proposer = createWorker({
      transport: httpTransport(origin()),
      businessKey: 'alpha',
      credential: agent.token,
      delegation,
      reporter: SYNTHETIC_USAGE,
    });
    const proposed = await proposer.proposeOnce();
    if (!('proposed' in proposed)) throw new Error(`propose: ${JSON.stringify(proposed)}`);
    const read = await asAda('task.read', { recordId: taskId });
    const task = read['task'] as { proposals: { versions: { versionId: string }[] }[] };
    const decided = await asAda('task.decide', {
      gateId: proposed.proposed.gateId,
      versionId: String(task.proposals[0]?.versions[0]?.versionId),
      decision: 'approve',
      note: 'approve this version',
    });
    const decisionId = String((decided['detail'] as Record<string, unknown>)['decisionId']);
    return { taskId, delegation, decisionId, token: agent.token };
  };

  return {
    world,
    admin,
    asAda,
    approvedWork,
    api: async (label) => {
      const started = await startApi(world, PROOF_PORT as string, label);
      live.push(started);
      return { ...started, appName: label };
    },
    worker: (w, parkAt, name, leaseSeconds = 900, fault = 'none') => {
      const started = startWorker({
        api: origin(),
        ...w,
        parkAt,
        leaseSeconds,
        appName: name,
        fault,
      });
      live.push(started);
      return started;
    },
    effects: async (taskId) =>
      (
        await admin.execute(
          `select 1 from public.operations
            where business_id = $1 and record_id = $2 and command = 'task.comment'
              and outcome = 'applied' and operation_id like 'effect:%'`,
          [world.alpha, taskId],
        )
      ).length,
    attempts: async (taskId) =>
      await admin.execute<{ id: string; state: string; drop_cause: string | null }>(
        `select att.id, att.state, att.drop_cause from public.attempts att
           join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
           join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
          where att.business_id = $1 and env.task_id = $2 order by att.created_at, att.id`,
        [world.alpha, taskId],
      ),
    close: async () => {
      for (const one of live) {
        try {
          process.kill(one.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      // Ended, not merely signalled: the next proof file starts its API on the
      // same port and refuses one that still answers there.
      await Promise.all(live.map(async (one) => await one.exited()));
      await admin.close();
      await world.close();
    },
  };
}
