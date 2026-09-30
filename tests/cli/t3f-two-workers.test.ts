// SPDX-License-Identifier: AGPL-3.0-only
//
// T3f, T3-N1: two worker processes, one lease. Two OS processes, each the
// shipped worker (`apps/worker/worker.ts` over the command line's HTTP
// transport, as `apps/worker/main.ts` builds it) under a delegation of its
// own, race to apply one approved task on the served API process. Exactly one
// applies: one lease on the task, one effect. The other finds the work gone
// (`idle`) or its pickup refused. Named by the winner's lease and fence, the
// loser's identity is refused `LEASE_NOT_OWNED`, because a lease is its
// holder's and delegation's, and nothing moves. Neither process prints a
// credential.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import {
  executeAgentCommand,
  executeCommand,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { recordPid, serveApi, type ServedApi } from './cli-process-harness.ts';

const ROOT = resolve(import.meta.dirname, '../..');

/** One worker process: apply the task once and print what came back. */
const WORKER = `
import { httpTransport } from ${JSON.stringify(join(ROOT, 'apps/cli/client.ts'))};
import { SYNTHETIC_USAGE } from ${JSON.stringify(join(ROOT, 'apps/worker/usage.ts'))};
import { createWorker } from ${JSON.stringify(join(ROOT, 'apps/worker/worker.ts'))};
const worker = createWorker({
  transport: httpTransport(process.env.OPS_ASTRO_API_URL),
  businessKey: process.env.OPS_ASTRO_BUSINESS,
  credential: process.env.OPS_ASTRO_TOKEN,
  delegation: process.env.OPS_ASTRO_DELEGATION,
  reporter: SYNTHETIC_USAGE,
});
process.stdout.write(JSON.stringify(await worker.applyOnce(process.env.T3F_TASK)));
`;

interface Ran {
  readonly outcome: Record<string, unknown>;
  readonly out: string;
}

function runWorker(env: Readonly<Record<string, string>>): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    recordPid('t3f worker', child.pid);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', fail);
    child.on('close', () => {
      try {
        done({ outcome: JSON.parse(out.trim()) as Record<string, unknown>, out });
      } catch {
        fail(new Error(`worker printed no outcome: ${out}`));
      }
    });
  });
}

const detailOf = (result: Awaited<ReturnType<typeof executeCommand>>): Record<string, unknown> => {
  if (isCommandRefusal(result)) throw new Error(`refused ${result.code}`);
  return result.detail as Record<string, unknown>;
};

describe.skipIf(serverUrl === undefined)('T3f two worker processes, one lease', () => {
  let world: World;
  let api: ServedApi | undefined;

  const asAda = async (body: Record<string, unknown>) =>
    await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);

  /** A delegation of the worker's own, on the one task. */
  const delegation = async (taskId: string): Promise<string> =>
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: world.agent.actorId,
        delegatePersonId: world.ada.personId as string,
        mintedByActorId: world.ada.actorId as string,
        purpose: `t3f_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.credential;
    });

  beforeAll(async () => {
    world = await createWorld('t3ftwo');
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    await world?.close();
  }, 60_000);

  it('exactly one process applies under the one lease; the other is refused by lease identity', async () => {
    const created = await asAda({ command: 'task.create', fields: { title: 'two workers' } });
    if (isCommandRefusal(created) || created.recordId === null) throw new Error('no task');
    const taskId = created.recordId;
    const revision = created.revision ?? 1;
    const gate = detailOf(
      await asAda({
        command: 'task.propose',
        recordId: taskId,
        expectedRevision: revision,
        purpose: `t3f_${randomUUID().slice(0, 8)}`,
        maximumMinor: 2_000,
        currency: 'AUD',
        payload: { change: 'a team-only comment' },
        step: { kind: 'synthetic_comment', payload: {} },
      }),
    );
    detailOf(
      await asAda({
        command: 'task.decide',
        gateId: gate['gateId'],
        versionId: gate['versionId'],
        decision: 'approve',
        note: 'two workers race for it',
      }),
    );
    const credentials = [await delegation(taskId), await delegation(taskId)];
    const env = (credential: string) => ({
      OPS_ASTRO_API_URL: (api as ServedApi).origin,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: world.agent.token,
      OPS_ASTRO_DELEGATION: credential,
      T3F_TASK: taskId,
    });

    const ran = await Promise.all(credentials.map(async (one) => await runWorker(env(one))));
    for (const [at, one] of ran.entries()) {
      for (const secret of [...credentials, world.agent.token]) {
        expect(one.out, `worker ${String(at)} printed a credential`).not.toContain(secret);
      }
    }
    const kinds = ran.map((one) => Object.keys(one.outcome)[0]);
    const winner = kinds.indexOf('applied');
    expect(
      kinds.filter((kind) => kind === 'applied'),
      JSON.stringify(ran),
    ).toHaveLength(1);
    const loser = ran[1 - winner]?.outcome ?? {};
    expect(
      'idle' in loser ||
        ['RESERVATION_NOT_CLAIMABLE', 'LEASE_HELD'].includes(
          String((loser['refused'] as Record<string, unknown> | undefined)?.['code']),
        ),
      JSON.stringify(loser),
    ).toBe(true);

    const leases = await world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
      'select id, fence::text as fence from public.leases where task_id = $1',
      [taskId],
    );
    expect(leases).toHaveLength(1);
    const effects = await world.db.admin.execute<{ readonly id: string }>(
      `select id from public.operations
        where record_id = $1 and command = 'task.comment' and outcome = 'applied'`,
      [taskId],
    );
    expect(effects).toHaveLength(1);

    // The loser names the winner's lease: not its own.
    const [lease] = leases;
    const before = await world.db.admin.execute('select * from public.leases where task_id = $1', [
      taskId,
    ]);
    const named = await executeAgentCommand(
      world.db.app,
      world.alpha,
      world.agent.presented,
      credentials[1 - winner],
      {
        command: 'task.heartbeat',
        operationId: randomUUID(),
        leaseId: lease?.id,
        fence: Number(lease?.fence),
      } as never,
    );
    expect(isCommandRefusal(named) && named.code).toBe('LEASE_NOT_OWNED');
    expect(
      await world.db.admin.execute('select * from public.leases where task_id = $1', [taskId]),
    ).toStrictEqual(before);
  }, 120_000);
});
