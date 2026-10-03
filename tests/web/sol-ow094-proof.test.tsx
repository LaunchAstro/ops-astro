// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { realDuplicate } from '../../apps/web/src/screens/task/client-seam.ts';
import { DuplicateForm } from '../../apps/web/src/screens/task/DuplicateForm.tsx';
import type { InternalTaskDetail, InternalTaskRead } from '../../packages/core-wire/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { writingWorld, type WritingWorld } from '../commands/writing-support.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { settleWrites } from './writing-support.tsx';

let world: WritingWorld;
beforeAll(async () => {
  world = await writingWorld();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, world.writer, 'share');
    await grantTo(tx, world.writer, 'comment');
  });
});
afterEach(unmountAll);
afterAll(async () => {
  await world?.db.drop();
});

async function command(body: object) {
  return await executeCommand(world.db.app, world.alpha, world.writer.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function read(recordId: string): Promise<InternalTaskDetail> {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async () => json(await world.readAs(world.alpha, world.writer, recordId)),
  });
  const answer = await client.read<InternalTaskRead>('task.read', { recordId });
  if (!('ok' in answer)) throw new Error('proof setup: task unreadable');
  return answer.value.task;
}

function transport(run: typeof globalThis.fetch) {
  const pending: Promise<Response>[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const response = run(input, init);
    pending.push(response);
    return response;
  };
  return {
    fetch,
    async flush() {
      await act(async () => {
        await Promise.allSettled(pending);
      });
      await settleWrites();
    },
  };
}

it('Sol proof, criterion 5: retrying a duplicate after its committed response is lost creates only one task', async () => {
  const source = await world.fresh(world.alpha, world.writer, 'original shell');
  const target = randomUUID();
  await addClient(world.db.app, world.alpha, target, world.writer);
  const task = await read(source.recordId);
  const operationIds: unknown[] = [];
  const wire = transport(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    operationIds.push(body['operationId']);
    const result = await command({ ...body, command: 'task.duplicate' });
    if (isCommandRefusal(result)) throw new Error(`proof setup: ${result.code}`);
    // Lose the response only after the real command and register committed.
    if (operationIds.length === 1) throw new TypeError('response lost after commit');
    return json(result);
  });
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: wire.fetch,
  });
  const opens: string[] = [];
  const view = await mount(
    <DuplicateForm
      task={task}
      choices={[{ id: target, name: 'target' }]}
      send={realDuplicate(client).send}
      onDuplicated={(key) => opens.push(key)}
      onCancel={() => {}}
    />,
  );
  await view.choose('#duplicate-client', target);
  await view.click('[data-duplicate="create"]');
  await wire.flush();
  expect(view.find('[role="alert"]')?.textContent).toContain('response lost after commit');
  expect(opens).toHaveLength(0);
  await view.click('[data-duplicate="create"]');
  await wire.flush();
  expect(operationIds).toHaveLength(2);
  expect(opens).toHaveLength(1);
  const copies = await world.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.record_links where business_id = $1 and link_type = $2 and to_record_id = $3',
    [world.alpha, 'duplicated_from', source.recordId],
  );
  expect(Number(copies[0]?.n), 'the same Create made a second durable task').toBe(1);
});
