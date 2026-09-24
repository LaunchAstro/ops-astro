// SPDX-License-Identifier: AGPL-3.0-only
//
// U1 from DECISION-INTEGRITY: the one `onError` line in the composed server
// that lets a named fault answer as itself.
//
// `decision-integrity-read.test.ts` proves `DECISION_INTEGRITY` under 500
// through `createApi` in process. The real server wraps that app in its own
// `onError`, and a handler that answered every throw with 503
// `SERVICE_UNAVAILABLE` would turn the named fault back into a retry hint in
// front of a person. So each case reads a decided task, tampers one decision
// row as the database owner, reads again, restores the row and reads a third
// time.
//
// It is asked twice. In process, through `composeApi` from
// `apps/api/server.ts`, the same composition the server listens with, which
// also reaches the fault branch: a throw that names nothing answers 503. Over
// the socket, `apps/api/server.ts` started as its own process, asked only when
// `SURFACE_API_PORT` names a spare loopback port and otherwise printed as
// skipped.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { composeApi } from '../../apps/api/server.ts';
import { ACCEPTANCE_SECRET } from '../acceptance/cast.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { asAda, revisionOf } from '../acceptance/restart-harness.ts';
import { overHttp, startApi, type RunningApi } from '../acceptance/restart-process.ts';

const port = process.env['SURFACE_API_PORT'];

/** A task with one approved gate on it, and that gate. */
async function decidedTask(world: World): Promise<{ taskId: string; gateId: string }> {
  const created = await asAda(world, world.api, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision the real server reads ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const proposed = await asAda(world, world.api, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  const gateId = String(detail['gateId']);
  const decided = await asAda(world, world.api, '/task/decide', {
    operationId: randomUUID(),
    gateId,
    versionId: String(detail['versionId']),
    decision: 'approve',
    note: 'approve as proposed',
  });
  expect(decided.code, 'decide').toBe('ok');
  return { taskId, gateId };
}

/** One statement as the owner, with the append-only triggers off for it alone. */
async function tamper(world: World, gateId: string, sql: string): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(sql, [world.alpha, gateId]);
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

const ROUND_UP =
  'update public.gate_decisions set round = round + 1 where business_id = $1 and gate_id = $2';
const ROUND_DOWN =
  'update public.gate_decisions set round = round - 1 where business_id = $1 and gate_id = $2';

const INTEGRITY = {
  code: 'DECISION_INTEGRITY',
  names: [],
  fixes: [
    'The stored decisions on this task did not verify, so none of it was shown.',
    'Nothing was changed. Retrying will give the same answer; report it to the operator.',
  ],
};

describe.skipIf(serverUrl === undefined)(
  'U1 in process: the composed server answers a tampered decision with the named fault',
  () => {
    let world: World;
    let api: World['api'];
    let taskId: string;
    let gateId: string;

    const readInProcess = async () =>
      await asAda(world, api, '/task/read', { operationId: randomUUID(), recordId: taskId });

    beforeAll(async () => {
      world = await createWorld('sfi');
      ({ taskId, gateId } = await decidedTask(world));
      api = composeApi({
        database: world.db.app,
        admin: world.db.admin,
        secret: ACCEPTANCE_SECRET,
        executeRead,
      }).app;
    }, 120_000);

    afterAll(async () => {
      await world?.close();
    }, 60_000);

    it('reads the verified decision before anything is altered', async () => {
      const answer = await readInProcess();
      expect(answer.status).toBe(200);
      expect(answer.code).toBe('ok');
    });

    it('answers DECISION_INTEGRITY under 500, not 503 SERVICE_UNAVAILABLE, once a round is altered', async () => {
      await tamper(world, gateId, ROUND_UP);
      const answer = await readInProcess();
      expect(answer.status).toBe(500);
      expect(answer.body).toStrictEqual(INTEGRITY);
    });

    it('reads green again once the row is restored', async () => {
      await tamper(world, gateId, ROUND_DOWN);
      const answer = await readInProcess();
      expect(answer.status).toBe(200);
      expect(answer.code).toBe('ok');
    });

    it('answers a fault that names nothing 503 SERVICE_UNAVAILABLE, without its message', async () => {
      const faulty = composeApi({
        database: world.db.app,
        admin: world.db.admin,
        secret: ACCEPTANCE_SECRET,
        executeRead: async () =>
          await Promise.reject(new Error('a message that may carry a value')),
      }).app;
      const answer = await asAda(world, faulty, '/task/read', {
        operationId: randomUUID(),
        recordId: taskId,
      });
      expect(answer.status).toBe(503);
      expect(answer.body).toStrictEqual({
        code: 'SERVICE_UNAVAILABLE',
        names: [],
        fixes: [
          'The service could not complete the request. Retry; if it persists, check /api/health.',
        ],
      });
    });

    it('measures /api/health on the administrative connection', async () => {
      const response = await api.fetch(new Request('http://api.test/api/health'));
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        ok: true,
        database: 'reachable',
        reads: 'mounted',
        detail: '',
      });
    });
  },
);

describe.skipIf(serverUrl === undefined || port === undefined)(
  'U1: the real server answers a tampered decision with the named fault',
  () => {
    let world: World;
    let running: RunningApi | undefined;
    let api: World['api'];
    let taskId: string;
    let gateId: string;

    const readOverSocket = async () =>
      await asAda(world, api, '/task/read', { operationId: randomUUID(), recordId: taskId });

    beforeAll(async () => {
      world = await createWorld('sfu');
      ({ taskId, gateId } = await decidedTask(world));

      running = await startApi(world, port as string);
      api = overHttp(running.port);
      console.log(`u1: apps/api/server.ts pid ${String(running.pid)} on 127.0.0.1:${running.port}`);
    }, 120_000);

    afterAll(async () => {
      if (running !== undefined) {
        const { pid } = running;
        await running.stop();
        console.log(`u1: stopped pid ${String(pid)}`);
      }
      await world?.close();
    }, 60_000);

    it('reads the verified decision before anything is altered', async () => {
      const answer = await readOverSocket();
      expect(answer.status).toBe(200);
      expect(answer.code).toBe('ok');
    });

    it('answers DECISION_INTEGRITY under 500, not 503 SERVICE_UNAVAILABLE, once a round is altered', async () => {
      await tamper(world, gateId, ROUND_UP);
      const answer = await readOverSocket();
      console.log(`u1: tampered read ${String(answer.status)} ${JSON.stringify(answer.body)}`);
      expect(answer.status).toBe(500);
      expect(answer.body).toStrictEqual(INTEGRITY);
    });

    it('reads green again once the row is restored', async () => {
      await tamper(world, gateId, ROUND_DOWN);
      const answer = await readOverSocket();
      expect(answer.status).toBe(200);
      expect(answer.code).toBe('ok');
    });
  },
);
