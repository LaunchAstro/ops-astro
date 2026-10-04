// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { DuplicateForm } from '../../apps/web/src/screens/task/DuplicateForm.tsx';
import { realDuplicate } from '../../apps/web/src/screens/task/client-seam.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  alpha,
  clientA,
  clientB,
  db,
  detailOf,
  owner,
  setUp,
  taskFor,
  tearDown,
} from '../commands/duplicate-world.ts';

let databaseStarted = false;
afterEach(async () => {
  await unmountAll();
  if (databaseStarted) {
    databaseStarted = false;
    await tearDown();
  }
});

async function until(ready: () => boolean): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if (ready()) return;
    // oxlint-disable-next-line no-await-in-loop -- wait for the real transaction and React settlement
    await tick();
  }
  throw new Error('The duplicate request did not settle');
}

// Sol OW-090.2 criterion 5, retitled by what it proves; its body is Sol's.
it('retrying a duplicate after its committed response is lost creates only one task', async () => {
  databaseStarted = true;
  await setUp();
  const oldId = await taskFor(alpha, owner, 'Source shell', clientA);
  const read = await detailOf(owner, oldId);
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('The source task did not read');
  expect(read.task.comments).toHaveLength(0);
  const identities: unknown[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    identities.push(body['operationId']);
    // Run the production envelope and handler against the fresh database.
    // Lose the first response only after its transaction has committed.
    const result = await executeCommand(db.app, alpha, owner.presented, 'app', {
      ...body,
      command: 'task.duplicate',
    });
    if (isCommandRefusal(result)) throw new Error(`Proof setup refused: ${result.code}`);
    if (identities.length === 1) throw new TypeError('response lost after commit');
    return json(result);
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: transport,
  });
  const source = realDuplicate(client);
  let openedKey: string | null = null;
  const view = await mount(
    <DuplicateForm
      task={{ ...read.task, comments: [], client: clientA, hasContent: false }}
      choices={[{ id: clientB, name: 'Target client' }]}
      send={source.send}
      onDuplicated={(key) => {
        openedKey = key;
      }}
      onCancel={() => {
        throw new Error('Cancel is not part of this proof');
      }}
    />,
  );
  await view.choose('#duplicate-client', clientB);
  await view.click('[data-duplicate="create"]');
  await until(() => view.text().includes('response lost after commit'));
  expect(view.text()).toContain('response lost after commit');
  await view.click('[data-duplicate="create"]');
  await until(() => openedKey !== null);
  expect(identities).toHaveLength(2);
  const links = await db.admin.execute<{ count: string }>(
    `select count(*)::text as count from public.record_links
      where business_id = $1 and link_type = 'duplicated_from' and to_record_id = $2`,
    [alpha, oldId],
  );
  expect(
    Number(links[0]?.count),
    'An unchanged retry used a new operation ID and committed another task',
  ).toBe(1);
});
