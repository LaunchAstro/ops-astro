// SPDX-License-Identifier: AGPL-3.0-only
//
// U112 Core 04 5, against a real database: the new-task draft's owner, sent at
// Create as the draft sends it, reads back as chosen. An AI agent reads back
// by name and is recorded without a delegation or a run (a person launches
// one); a person reads back as the assignee; nobody leaves the task unheld.
// The draft offers the agents `task.board` names for the reader: their own,
// never another person's or another business's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { agentOwnedBy, enrol } from '../commands/fixture.ts';
import {
  aiWorld,
  assign,
  created,
  heldAs,
  holder,
  ownedAgent,
  type AiWorld,
} from '../commands/ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('u112-draft-ai-owner-readback: DATABASE_URL is unset, so nothing below ran.');
}

let w: AiWorld;
let penny: string;
let quill: string;
let faraway: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('u112owner');
  penny = await ownedAgent(w, w.p, 'Penny');
  quill = await ownedAgent(w, w.q, 'Quill');
  const foreign = await insertBusiness(w.world.db.app, `u112-owner-${randomUUID().slice(0, 8)}`);
  const stranger = await enrol(w.world.db.app, foreign, 'stranger');
  faraway = await agentOwnedBy(w.world.db.app, foreign, stranger.personId, 'Faraway');
}, 180_000);

afterAll(async () => {
  await w?.world.drop();
});

const delegations = async (): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.delegations where business_id = $1`,
        [w.world.business],
      )
    )[0]?.n ?? '0',
  );

describe.skipIf(serverUrl === undefined)('U112 Core 04 5: the draft’s owner reads back', () => {
  it('the draft is offered the reader’s own agents only, by name', async () => {
    const read = await executeRead(w.world.db.app, w.world.business, w.p.presented, {
      read: 'task.board',
      board: null,
    });
    if (isCommandRefusal(read) || !('myAgents' in read)) throw new Error('task.board refused');
    const offered = read.myAgents ?? [];
    expect(offered).toContainEqual({ agentId: penny, name: 'Penny' });
    expect(offered.map((one) => one.agentId)).not.toContain(quill);
    expect(offered.map((one) => one.agentId)).not.toContain(faraway);
    expect(JSON.stringify(read)).not.toContain('Faraway');
  });

  it('an AI agent reads back by name, recorded with no delegation and no run', async () => {
    const before = await delegations();
    const task = await created(w, w.p, 'Brief the booking page');
    expect(isCommandRefusal(await assign(w, w.p, task, { agent: penny }))).toBe(false);
    expect(await heldAs(w, w.p, task)).toMatchObject({
      agentId: penny,
      name: 'Penny',
      live: false,
    });
    expect(await holder(w, task)).toStrictEqual({ agent: penny, person: null });
    expect(await delegations()).toBe(before);
  });

  it('a person reads back as the assignee, and nobody leaves the task unheld', async () => {
    const task = await created(w, w.p, 'Call the client');
    expect(isCommandRefusal(await assign(w, w.p, task, { assignee: w.q.personId }))).toBe(false);
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: w.q.personId });
    const unheld = await created(w, w.p, 'Nobody yet');
    expect(await holder(w, unheld)).toStrictEqual({ agent: null, person: null });
  });

  it('another person’s or another business’s agent is refused as the owner, naming nothing of it', async () => {
    const task = await created(w, w.p, 'Not yours to hand');
    for (const agent of [quill, faraway]) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time, at the task's revision
      const answer = await assign(w, w.p, task, { agent });
      expect(isCommandRefusal(answer) ? answer.names : 'applied').toEqual(['agent']);
      expect(JSON.stringify(answer)).not.toContain('Faraway');
    }
    expect(await holder(w, task)).toStrictEqual({ agent: null, person: null });
  });
});
