// SPDX-License-Identifier: AGPL-3.0-only
//
// The shipped command line, `apps/cli/client.ts`, over a real socket to
// `apps/api/server.ts` running as its own process.
//
// `cli-reach.test.ts`, `protected-fields.test.ts` and `model-negatives.test.ts`
// drive `createCli` with the in-process app as its transport. That proves the
// client composes the path the app routes, and not that the mounted boundary
// answers it: nothing there crosses a socket or a process. Here the transport
// is `fetch` to the real server, and every answer is checked twice: once as
// the client hands it back, and once in the database it claims to have moved.
//
// Three groups:
//   1. a journey: create, assign, start, complete, then a reload through
//      `task.read`;
//   2. D05, the planner: a classified `preset.plan` answers 200 and adds no
//      `field_defs` row; one with an unclassified field answers 422
//      `PRESET_FIELD_UNCLASSIFIED` naming only that key and adds none;
//   3. D03, one cell: `task.update` carrying `client_visible` is refused with
//      the register's code, and the stored row does not move.
//
// Asked only when `SURFACE_API_PORT` names a spare loopback port. Otherwise
// every case is printed as skipped.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCli, type CliAnswer } from '../../apps/cli/client.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { startApi, type RunningApi } from '../acceptance/restart-process.ts';

const port = process.env['SURFACE_API_PORT'];

/** A success the write surface answers: the record and the revision it is now at. */
interface Written {
  readonly recordId: string;
  readonly revision: number;
}

/** A refusal as it crosses the wire: four keys and no fifth for a value to ride out in. */
interface Refusal {
  readonly refused: true;
  readonly code: string;
  readonly names: readonly string[];
  readonly fixes: readonly string[];
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function written(answer: CliAnswer): Written {
  const { body } = answer;
  if (
    answer.status !== 200 ||
    !isObject(body) ||
    typeof body['recordId'] !== 'string' ||
    typeof body['revision'] !== 'number'
  ) {
    throw new Error(`not a write answer: ${String(answer.status)} ${JSON.stringify(body)}`);
  }
  return { recordId: body['recordId'], revision: body['revision'] };
}

function refusal(answer: CliAnswer): Refusal {
  const { body } = answer;
  if (
    !isObject(body) ||
    body['refused'] !== true ||
    typeof body['code'] !== 'string' ||
    !Array.isArray(body['names']) ||
    !Array.isArray(body['fixes'])
  ) {
    throw new Error(`not a refusal: ${String(answer.status)} ${JSON.stringify(body)}`);
  }
  return body as unknown as Refusal;
}

describe.skipIf(serverUrl === undefined || port === undefined)(
  'the command line over a real socket to the real server',
  () => {
    let world: World;
    let running: RunningApi | undefined;
    let cli: ReturnType<typeof createCli>;

    /** The stored row, read as the owner so row security is not what answers. */
    async function stored(recordId: string) {
      const rows = await world.db.admin.execute<{
        readonly revision: string;
        readonly data: Readonly<Record<string, unknown>>;
      }>('select revision::text as revision, data from public.records where id = $1', [recordId]);
      const row = rows[0];
      if (row === undefined) throw new Error(`no record ${recordId}`);
      return { revision: Number(row.revision), data: row.data };
    }

    const countFieldDefs = async (): Promise<number> => {
      const rows = await world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.field_defs where business_id = $1',
        [world.alpha],
      );
      return Number(rows[0]?.n ?? '-1');
    };

    beforeAll(async () => {
      world = await createWorld('sfc');
      running = await startApi(world, port as string);
      console.log(
        `cli: apps/api/server.ts pid ${String(running.pid)} on 127.0.0.1:${running.port}`,
      );
      const origin = `http://127.0.0.1:${running.port}`;
      cli = createCli({
        businessKey: 'alpha',
        credential: world.ada.token,
        transport: async (path, body, credential) =>
          await fetch(`${origin}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body,
          }),
      });
    }, 120_000);

    afterAll(async () => {
      if (running !== undefined) {
        const { pid } = running;
        await running.stop();
        console.log(`cli: stopped pid ${String(pid)}`);
      }
      await world?.close();
    }, 60_000);

    it('creates, assigns, starts and completes a task, and a reload reads what the database holds', async () => {
      const title = `through the command line ${randomUUID()}`;
      const made = written(
        await cli.run('task.create', { operationId: randomUUID(), fields: { title } }),
      );
      expect((await stored(made.recordId)).revision).toBe(made.revision);

      const assigned = written(
        await cli.run('task.assign', {
          operationId: randomUUID(),
          recordId: made.recordId,
          expectedRevision: made.revision,
          fields: { assignee: world.mia.personId },
        }),
      );
      const afterAssign = await stored(made.recordId);
      expect(afterAssign.data['assignee']).toBe(world.mia.personId);
      expect(afterAssign.revision).toBe(assigned.revision);

      const started = written(
        await cli.run('task.start', {
          operationId: randomUUID(),
          recordId: made.recordId,
          expectedRevision: assigned.revision,
        }),
      );
      const afterStart = await stored(made.recordId);
      expect(afterStart.revision).toBe(started.revision);
      expect(afterStart.data['state']).not.toBe(afterAssign.data['state']);

      const completed = written(
        await cli.run('task.complete', {
          operationId: randomUUID(),
          recordId: made.recordId,
          expectedRevision: started.revision,
        }),
      );
      const afterComplete = await stored(made.recordId);
      expect(afterComplete.revision).toBe(completed.revision);
      expect(afterComplete.data['state']).not.toBe(afterStart.data['state']);
      expect(afterComplete.data['completed_at']).toStrictEqual(expect.any(String));

      const reload = await cli.run('task.read', { recordId: made.recordId });
      expect(reload.status).toBe(200);
      const body = reload.body;
      if (!isObject(body) || body['ok'] !== true || !isObject(body['task'])) {
        throw new Error(`not a task read: ${JSON.stringify(body)}`);
      }
      const task = body['task'];
      expect(task['id']).toBe(made.recordId);
      expect(task['revision']).toBe(afterComplete.revision);
      expect(task['title']).toBe(title);
      const assignee = task['assignee'];
      const state = task['state'];
      if (!isObject(assignee) || !isObject(state)) {
        throw new Error(`no assignee or state on the read: ${JSON.stringify(task)}`);
      }
      expect(assignee['personId']).toBe(world.mia.personId);
      expect(state['id']).toBe(afterComplete.data['state']);
      expect(state['machineCategory']).toBe('completed');
      expect(task['completedAt']).toStrictEqual(expect.any(String));
    });

    it('D05: answers a classified plan with 200 and writes no field_defs row', async () => {
      const before = await countFieldDefs();
      const answer = await cli.run('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'cli',
        fields: [{ key: 'cli_note', label: 'Note', valueType: 'text', writeMode: 'generic' }],
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, plan: { presetKey: 'cli' } });
      expect(await countFieldDefs()).toBe(before);
    });

    it('D05: refuses an unclassified field by name with 422, writing no field_defs row', async () => {
      const before = await countFieldDefs();
      const answer = await cli.run('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'cli',
        fields: [
          { key: 'valid_beside_it', label: 'Valid', valueType: 'text', writeMode: 'generic' },
          { key: 'unclassified_note', label: 'Note', valueType: 'text' },
        ],
      });
      expect(answer.status).toBe(422);
      const refused = refusal(answer);
      expect(refused.code).toBe('PRESET_FIELD_UNCLASSIFIED');
      expect(refused.names).toStrictEqual(['unclassified_note']);
      expect(await countFieldDefs()).toBe(before);
    });

    it('D03: refuses client_visible on task.update with TRANSITION_PROTECTED, and the row does not move', async () => {
      const made = written(
        await cli.run('task.create', {
          operationId: randomUUID(),
          fields: { title: `the record no refusal may move ${randomUUID()}` },
        }),
      );
      const before = await stored(made.recordId);
      const answer = await cli.run('task.update', {
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: before.revision,
        fields: { client_visible: true },
      });
      expect(answer.status).toBe(422);
      const refused = refusal(answer);
      expect(refused.code).toBe('TRANSITION_PROTECTED');
      expect(refused.names).toStrictEqual(['client_visible=task.set_audience']);
      expect(Object.keys(refused).toSorted()).toStrictEqual(['code', 'fixes', 'names', 'refused']);
      expect(await stored(made.recordId)).toStrictEqual(before);
    });
  },
);
