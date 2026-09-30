// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-9 rank on the task read” cases: the database,
// the people and the helpers they read, set up once per test file that imports
// it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import { insertBusiness } from '../identity/fixture.ts';

import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { BusinessId } from '../../packages/core-records/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export type Body = Readonly<Record<string, unknown>>;

export type Marks = readonly [number | null, number | null, number | null];

export const CANARY: string = `canary-${randomUUID()}`;

export let db: FreshDatabase;

export let alpha: BusinessId;

export let bravo: BusinessId;

export let owner: Member;

export let bravoOwner: Member;

export let clientAViewer: Member;

export let pairViewer: Member;

export let nobody: Member;

export const ids: Record<string, string> = {};

export const command: (
  business: BusinessId,
  member: Member,
  body: Body,
) => Promise<
  import('../../packages/core-commands/src/commands/register-store.ts').CommandHandle
> = async (business: BusinessId, member: Member, body: Body) => {
  const answer = await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
};

export const revisionOf: (recordId: string) => Promise<number> = async (recordId: string) =>
  Number(
    (
      await db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

export const make: (
  business: BusinessId,
  by: Member,
  name: string,
  title: string,
  marks: Marks,
  client?: string,
) => Promise<string> = async (
  business: BusinessId,
  by: Member,
  name: string,
  title: string,
  marks: Marks,
  client?: string,
) => {
  const made = await command(business, by, { command: 'task.create', fields: { title } });
  const recordId = made.recordId ?? '';
  const [impact, confidence, ease] = marks;
  await command(business, by, {
    command: 'task.set_scores',
    recordId,
    expectedRevision: await revisionOf(recordId),
    fields: { impact, confidence, ease },
  });
  if (client !== undefined) {
    await command(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { client },
    });
  }
  ids[name] = recordId;
  return recordId;
};

export const read: (
  business: BusinessId,
  member: Member,
  recordId: string,
) => ReturnType<typeof executeRead> = async (
  business: BusinessId,
  member: Member,
  recordId: string,
) => await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

export const rankOf: (
  business: BusinessId,
  member: Member,
  recordId: string,
) => Promise<import('../../packages/core-wire/src/views.ts').RankView> = async (
  business: BusinessId,
  member: Member,
  recordId: string,
) => {
  const answer = await read(business, member, recordId);
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  return answer.task.rank;
};

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 'r' });
  alpha = (await insertBusiness(db.app, 'rank-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'rank-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  owner = await enrol(db.app, alpha, 'owner');
  bravoOwner = await enrol(db.app, bravo, 'bravo-owner');
  clientAViewer = await enrol(db.app, alpha, 'client-a-viewer');
  pairViewer = await enrol(db.app, alpha, 'pair-viewer');
  nobody = await enrol(db.app, alpha, 'nobody');
  await db.app.withBusiness(alpha, async (tx) => {
    // `share` only so each task can be put under its client (`task.set_party`).
    for (const action of ['read', 'write', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
  });
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, bravoOwner, action);
    }
  });
  const clientA = randomUUID();
  const clientB = randomUUID();
  // Alpha: 504, 900 (client B, the canary), 630, and one unscored.
  await make(alpha, owner, 'a504', 'client A work', [7, 9, 8], clientA);
  await make(alpha, owner, 'b900', CANARY, [10, 10, 9], clientB);
  await make(alpha, owner, 'a630', 'second', [7, 9, 10], clientA);
  await make(alpha, owner, 'unscored', 'no ease yet', [5, 7, null]);
  // Bravo: a task that outscores everything in Alpha.
  await make(bravo, bravoOwner, 'bravo', CANARY, [10, 10, 10]);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, clientAViewer, 'read', { kind: 'record', id: ids['a504'] ?? '' });
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: ids['a504'] ?? '' });
    await grantTo(tx, pairViewer, 'read', { kind: 'record', id: ids['a630'] ?? '' });
  });
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
