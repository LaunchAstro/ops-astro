// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 "Duplicate without contents" under a live delegation, and its
// isolation. `task.duplicate` is a person's only: an agent credential is
// refused whatever its delegation holds, on its own task and another. The
// isolation case makes the three crossings: another business's task, another
// client's task in the same business, and an agent under a live delegation;
// each is refused, writes nothing, and no body carries the canary or the id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { CANARY, revision, serverUrl, setUp, tearDown, world } from './adhoc-agent-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-duplicate: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** Tasks, links and applied duplicates in every business: what a refusal must leave. */
const footprint = async (): Promise<readonly number[]> =>
  (
    await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records
       union all select count(*)::text from public.record_links
       union all select count(*)::text from public.audit_events
                  where command = 'task.duplicate' and outcome = 'applied'`,
    )
  ).map((row) => Number(row.n));

const body = (recordId: string, client: string | null) => ({
  command: 'task.duplicate',
  operationId: randomUUID(),
  recordId,
  client,
  title: 'copy',
  stepNames: ['one'],
  confirmCarried: true,
});

const created = (answer: CommandResult): string => {
  if (isCommandRefusal(answer)) throw new Error(`create refused ${answer.code}`);
  return answer.recordId ?? '';
};

const refusedClean = (answer: CommandResult, ids: readonly string[]): void => {
  expect(codeOf(answer)).not.toBe('not-a-refusal');
  const text = JSON.stringify(answer);
  expect(text).not.toContain(CANARY);
  for (const id of ids) expect(text).not.toContain(id);
};

/** A task of `client`, made and placed by `by` (who holds task:share for the move). */
async function taskOf(by: Member, client: string): Promise<string> {
  const taskId = created(
    await world.asPerson(by, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: CANARY },
    }),
  );
  const party = await world.asPerson(by, {
    command: 'task.set_party',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revision(taskId),
    fields: { client },
  });
  expect(codeOf(party)).toBe('not-a-refusal');
  return taskId;
}

/** A second business whose writer holds read and write on all of its tasks. */
async function otherBusiness(): Promise<{
  readonly writer: Member;
  readonly as: (sent: Record<string, unknown>) => Promise<CommandResult>;
}> {
  const bravo = (await insertBusiness(
    world.db.app,
    `dup-b-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  const writer = await enrol(world.db.app, bravo, 'bravo-writer');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, writer, 'read');
    await grantTo(tx, writer, 'write');
  });
  return {
    writer,
    as: async (sent) =>
      await executeCommand(world.db.app, bravo, writer.presented, 'api', sent as never),
  };
}

describe.skipIf(serverUrl === undefined)('MP-4-8 agent duplicate refused', () => {
  it('MP-4-8 agent duplicate refused', async () => {
    const decider = await world.decider('dup-decider');
    const picked = await world.pickUp(decider, CANARY);
    const other = created(
      await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: CANARY },
      }),
    );
    const client = randomUUID();
    const before = await footprint();
    const tries = [picked.taskId, other].flatMap((taskId) =>
      [client, null].map(async (chosen) => {
        const answer = await world.asAgent(body(taskId, chosen), picked.credential);
        refusedClean(answer, [taskId]);
      }),
    );
    await Promise.all(tries);
    expect(await footprint()).toStrictEqual(before);
    // The person who delegated duplicates it on the person entry.
    const own = await world.asPerson(decider, body(picked.taskId, client));
    expect(codeOf(own)).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 duplicate isolation', () => {
  it('MP-4-8 duplicate isolation: another business, another client, a live delegation', async () => {
    const decider = await world.decider('iso-decider');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, decider, 'share');
    });
    const [clientA, clientB] = [randomUUID(), randomUUID()];
    const oldA = await taskOf(decider, clientA);
    const ownB = await taskOf(decider, clientB);
    const bravo = await otherBusiness();
    // Another client: a person holding read and write on client B's task only.
    const readerB = await enrol(world.db.app, world.business, 'client-b-reader');
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, readerB, 'read', { kind: 'record', id: ownB });
      await grantTo(tx, readerB, 'write', { kind: 'party', id: clientB });
    });
    const picked = await world.pickUp(decider, 'delegated');

    const before = await footprint();
    const crossings: readonly [string, Promise<CommandResult>, string][] = [
      ['another business', bravo.as(body(oldA, null)), 'NOT_FOUND'],
      ['another client', world.asPerson(readerB, body(oldA, clientB)), 'SCOPE_NOT_GRANTED'],
      ['a live delegation', world.asAgent(body(oldA, clientA), picked.credential), 'any'],
    ];
    for (const [label, answer, code] of await Promise.all(
      crossings.map(async ([name, sent, want]) => [name, await sent, want] as const),
    )) {
      refusedClean(answer, [oldA]);
      if (code !== 'any') expect(codeOf(answer), label).toBe(code);
    }
    expect(await footprint()).toStrictEqual(before);
    // Each crossing's own side is served: bravo's writer in bravo, the reader on its task.
    const bravoTask = created(
      await bravo.as({ command: 'task.create', operationId: randomUUID(), fields: { title: 'b' } }),
    );
    expect(codeOf(await bravo.as(body(bravoTask, null)))).toBe('not-a-refusal');
    expect(codeOf(await world.asPerson(readerB, body(ownB, clientB)))).toBe('not-a-refusal');
  });
});
