// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI isolation: three real crossings, statuses checked, and a stored
// canary (a task title) never in any answer, refusals included.
// - business to business: an agent of business A is not assignable in B, even
//   by a person of B holding every task grant there;
// - client to client: a delegation minted for client X's task cannot hold
//   client Y's task;
// - person to person: P cannot assign Q's agent, and Q's agent on a task gives
//   P nothing (not offered, not assignable).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf } from './agent-fixture.ts';
import { enrol, grantTo, installSpine } from './fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  holder,
  minted,
  offered,
  onClient,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('task-assign-ai-isolation: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('aiiso');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: business to business', () => {
  it('an agent of business A cannot be assigned a task in business B', async () => {
    const home = await created(w, w.p, `Home ${CANARY}`);
    const agent = await minted(w, w.p, home);
    const bravo = await insertBusiness(w.world.db.app, `ai-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- three grants
        await grantTo(tx, there, action);
      }
    });
    const made = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'Bravo task' },
    } as never);
    if (isCommandRefusal(made)) throw new Error(`bravo create refused ${made.code}`);
    const answer = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: made.recordId,
      expectedRevision: 1,
      fields: { agent },
    } as never);
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect((await holder(w, made.recordId ?? ''))?.agent).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: client to client', () => {
  it('a delegation minted for client X’s task cannot hold client Y’s task', async () => {
    const x = await created(w, w.p, `Client X ${CANARY}`);
    const y = await created(w, w.p, 'Client Y');
    await onClient(w, x, randomUUID());
    await onClient(w, y, randomUUID());
    const agent = await minted(w, w.p, x);
    const answer = await assign(w, w.p, y, { agent });
    expect(codeOf(answer)).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect((await holder(w, y))?.agent).toBeNull();
    expect(codeOf(await assign(w, w.p, x, { agent }))).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: person to person', () => {
  it('a reader sees no hint of another person’s agent', async () => {
    const task = await created(w, w.q, 'Sol private agent');
    const agent = await minted(w, w.q, task);
    expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');
    const read = await executeRead(w.world.db.app, w.world.business, w.p.presented, {
      read: 'task.read',
      recordId: task,
    });
    if (isCommandRefusal(read) || !('task' in read))
      throw new Error('Sol proof: task read refused');
    expect(read.task.agent).toBeNull();
    expect(read.task.myAgents).toStrictEqual([]);
  });

  it('P cannot assign Q’s agent; Q’s agent on a task gives P nothing', async () => {
    const task = await created(w, w.q, `Q's ${CANARY}`);
    const agent = await minted(w, w.q, task);
    const refused = await assign(w, w.p, task, { agent });
    expect(codeOf(refused)).toBe('NOT_FOUND');
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');
    const seen = await offered(w, w.p, task);
    expect(seen).toStrictEqual([]);
    expect(JSON.stringify(seen)).not.toContain(agent);
  });
});
