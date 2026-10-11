// SPDX-License-Identifier: AGPL-3.0-only
//
// Assign to AI isolation: real crossings, statuses checked, and a stored
// canary (a task title) never in any answer, refusals included.
// - business to business: an agent of business A is not assignable in B, even
//   by a person of B holding every task grant there, and is never offered there;
// - client to client: a person whose grants reach client X hands X's task to
//   their own agent, and cannot reach client Y's task with it; an
//   `agent:assign` scoped to one client directs nobody else's agent;
// - person to person: P cannot direct Q's agent and is not offered it, and a
//   revoked `agent:assign` stops directing it.

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
  directsEvery,
  holder,
  offered,
  onClient,
  ownedAgent,
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

const ids = (list: unknown): readonly string[] =>
  ((list as { agentId: string }[] | undefined) ?? []).map((one) => one.agentId);

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: business to business', () => {
  it('an agent of business A cannot be assigned a task in business B, nor offered there', async () => {
    const agent = await ownedAgent(w, w.p, `Home ${CANARY}`);
    const bravo = await insertBusiness(w.world.db.app, `ai-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- three grants
        await grantTo(tx, there, action);
      }
      await grantTo(tx, there, 'assign', undefined, false, 'agent');
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
    const read = await executeRead(w.world.db.app, bravo, there.presented, {
      read: 'task.read',
      recordId: made.recordId ?? '',
    });
    expect(JSON.stringify(read)).not.toContain(agent);
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });
});

/** A real client of the world's business, made by Q. */
async function clientNamed(name: string): Promise<string> {
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.q, 'write', undefined, false, 'record');
  });
  const made = await w.world.asPerson(w.q, {
    command: 'client.create',
    operationId: randomUUID(),
    name: `${name} ${randomUUID().slice(0, 6)}`,
  } as never);
  if (isCommandRefusal(made)) throw new Error(`client.create refused ${made.code}`);
  return String((made.detail as Record<string, unknown>)['clientId']);
}

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: client to client', () => {
  it('a person reaching client X hands X’s task to their agent and cannot reach Y’s', async () => {
    const [clientX, clientY] = [await clientNamed('Client X'), await clientNamed('Client Y')];
    const x = await created(w, w.q, 'Client X');
    const y = await created(w, w.q, `Client Y ${CANARY}`);
    const other = await created(w, w.q, 'Client X again');
    await onClient(w, x, clientX);
    await onClient(w, y, clientY);
    await onClient(w, other, clientX);
    const scoped = await w.world.decider('scoped');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      // The decider fixture's grants are business-wide; this one's reach is client X's task alone.
      await tx.query(
        `update public.grants set revoked_at = now()
          where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
        [scoped.personId],
      );
      for (const action of ['read', 'write', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- three grants
        await grantTo(tx, scoped, action, { kind: 'record', id: x });
        // eslint-disable-next-line no-await-in-loop -- three grants
        await grantTo(tx, scoped, action, { kind: 'record', id: other });
      }
      // A client's agent:assign is not the business-wide key that directs every agent.
      await grantTo(tx, scoped, 'assign', { kind: 'party', id: clientX }, false, 'agent');
    });
    const own = await ownedAgent(w, scoped);
    expect(codeOf(await assign(w, scoped, x, { agent: own }))).toBe('not-a-refusal');
    const refused = await assign(w, scoped, y, { agent: own });
    expect(['NOT_FOUND', 'SCOPE_NOT_GRANTED']).toContain(codeOf(refused));
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    expect((await holder(w, y))?.agent).toBeNull();
    const theirs = await ownedAgent(w, w.q);
    expect(codeOf(await assign(w, scoped, other, { agent: theirs }))).toBe('SCOPE_NOT_GRANTED');
    expect((await holder(w, other))?.agent).toBeNull();
    expect(ids(await offered(w, scoped, x))).not.toContain(theirs);
  });
});

describe.skipIf(serverUrl === undefined)('Assign to AI isolation: person to person', () => {
  it('P cannot direct Q’s agent and is not offered it', async () => {
    const task = await created(w, w.q, `Q's ${CANARY}`);
    const agent = await ownedAgent(w, w.q, 'Q helper');
    const refused = await assign(w, w.p, task, { agent });
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refused)).not.toContain(CANARY);
    expect(JSON.stringify(refused)).not.toContain('Q helper');
    expect((await holder(w, task))?.agent).toBeNull();
    expect(ids(await offered(w, w.p, task))).not.toContain(agent);
    expect(codeOf(await assign(w, w.q, task, { agent }))).toBe('not-a-refusal');
  });

  it('a revoked agent:assign directs nothing and offers nothing', async () => {
    const task = await created(w, w.q, 'Revoked director');
    const agent = await ownedAgent(w, w.q);
    const director = await w.world.decider('revoked-director');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, director, 'assign');
    });
    const grant = await directsEvery(w, director);
    expect(ids(await offered(w, director, task))).toContain(agent);
    await w.world.db.admin.execute(`update public.grants set revoked_at = now() where id = $1`, [
      grant,
    ]);
    expect(codeOf(await assign(w, director, task, { agent }))).toBe('SCOPE_NOT_GRANTED');
    expect(ids(await offered(w, director, task))).not.toContain(agent);
    expect((await holder(w, task))?.agent).toBeNull();
  });
});
