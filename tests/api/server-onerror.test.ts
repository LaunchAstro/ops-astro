// SPDX-License-Identifier: AGPL-3.0-only
//
// U1 from DECISION-INTEGRITY: the one `onError` line in `apps/api/server.ts`
// that lets a named fault answer as itself.
//
// `decision-integrity-read.test.ts` proves `DECISION_INTEGRITY` under 500
// through `createApi` in process. The real server wraps that app in its own
// `onError`, and a handler that answered every throw with 503
// `SERVICE_UNAVAILABLE` would turn the named fault back into a retry hint in
// front of a person. So this file starts `apps/api/server.ts` as its own
// process, reads a decided task over the socket, tampers one decision row as
// the database owner, reads again, restores the row and reads a third time.
//
// Asked only when `SURFACE_API_PORT` names a spare loopback port. Otherwise
// every case is printed as skipped.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { asAda, revisionOf } from '../acceptance/restart-harness.ts';
import { overHttp, startApi, type RunningApi } from '../acceptance/restart-process.ts';

const port = process.env['SURFACE_API_PORT'];

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

    /** One statement as the owner, with the append-only triggers off for it alone. */
    async function tamper(sql: string): Promise<void> {
      await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
      try {
        await world.db.admin.execute(sql, [world.alpha, gateId]);
      } finally {
        await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
      }
    }

    beforeAll(async () => {
      world = await createWorld('sfu');
      const created = await asAda(world, world.api, '/task/create', {
        operationId: randomUUID(),
        fields: { title: `a decision the real server reads ${randomUUID()}` },
      });
      expect(created.code, 'create').toBe('ok');
      taskId = String(created.body['recordId']);
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
      gateId = String(detail['gateId']);
      const decided = await asAda(world, world.api, '/task/decide', {
        operationId: randomUUID(),
        gateId,
        versionId: String(detail['versionId']),
        decision: 'approve',
        note: 'approve as proposed',
      });
      expect(decided.code, 'decide').toBe('ok');

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
      await tamper(
        'update public.gate_decisions set round = round + 1 where business_id = $1 and gate_id = $2',
      );
      const answer = await readOverSocket();
      console.log(`u1: tampered read ${String(answer.status)} ${JSON.stringify(answer.body)}`);
      expect(answer.status).toBe(500);
      expect(answer.body).toStrictEqual({
        code: 'DECISION_INTEGRITY',
        names: [],
        fixes: [
          'The stored decisions on this task did not verify, so none of it was shown.',
          'Nothing was changed. Retrying will give the same answer; report it to the operator.',
        ],
      });
    });

    it('reads green again once the row is restored', async () => {
      await tamper(
        'update public.gate_decisions set round = round - 1 where business_id = $1 and gate_id = $2',
      );
      const answer = await readOverSocket();
      expect(answer.status).toBe(200);
      expect(answer.code).toBe('ok');
    });
  },
);
