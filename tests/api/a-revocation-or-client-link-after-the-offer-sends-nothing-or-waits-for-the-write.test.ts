// SPDX-License-Identifier: AGPL-3.0-only
//
// Between a carried call's offer and its send, its authority can end: the
// grant revoked, a client linked to the page task, the agent's membership
// closed, the agent deactivated. Each committed after the offer and before
// the send judgement is seen by it: nothing is sent and the call is released.
// A change that comes once the send judgement has passed waits on the locks
// it holds until the agent reports the write, so the write happens before
// the change commits; when no write is reported it waits until the send
// window has passed, and no longer.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addClient } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import {
  ask,
  callFor,
  deactivateAgent,
  leaveMembership,
  repliesTo,
  revokeOwn,
} from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due.'];

type Change = 'grant revoked' | 'client linked' | 'membership left' | 'agent deactivated';

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('authority ending after the offer', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_after_offer');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  const commitChange = async (change: Change, k: string, link: () => Promise<void>) => {
    if (change === 'client linked') return await link();
    await world.database.withBusiness(world.w.fixture.business, async (tx) => {
      if (change === 'grant revoked') await revokeOwn(world, tx);
      if (change === 'membership left') await leaveMembership(tx, k);
      if (change === 'agent deactivated') await deactivateAgent(world, tx);
    });
  };

  /** A task to ask on, and how to link a client to it as the person does. */
  async function aTask(): Promise<{ readonly task: string; readonly link: () => Promise<void> }> {
    const { w } = world;
    const made = await w.as(w.owner, 'task.create', { fields: { title: `Plan ${randomUUID()}` } });
    const task = String(made.body['recordId']);
    const client = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, client, w.owner);
    const link = async (): Promise<void> => {
      const linked = await w.as(w.owner, 'task.set_party', {
        recordId: task,
        expectedRevision: made.body['revision'],
        fields: { client },
      });
      expect(linked.status).toBe(200);
    };
    return { task, link };
  }

  it.each(['grant revoked', 'client linked', 'membership left', 'agent deactivated'] as const)(
    '%s after the offer, before the send: nothing sent, released',
    async (change) => {
      const body = `What is due? (${change})`;
      const { task, link } = await aTask();
      world.agent.beforeAccept = async (k) => await commitChange(change, k, link);
      const events = await (await ask(world, body, undefined, task)).rest();
      expect(world.agent.sent).toHaveLength(0);
      expect(world.ollama.seen).toHaveLength(0);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested: false, actual: null },
      ]);
      expect(await repliesTo(world, body)).toBe(0);
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
    },
    60_000,
  );

  it.each([
    ['the write is reported', 'run', 0, 1_500],
    ['no write is reported', 'unreported', 2_000, 6_000],
  ] as const)(
    'a revocation once the send is judged waits on its locks until %s',
    async (_name, mode, least, most) => {
      const body = `What is due? (${mode})`;
      world.agent.mode = mode;
      const asking = ask(world, body);
      await world.agent.dispatched(1);
      const sentAt = Date.now();
      await commitChange('grant revoked', '', async () => {});
      const waited = Date.now() - sentAt;
      // The write happened before the revocation could commit: Ollama has the one request.
      expect(world.ollama.seen).toHaveLength(1);
      expect(waited).toBeGreaterThanOrEqual(least);
      expect(waited).toBeLessThan(most);
      world.agent.release();
      await (await asking).rest();
      expect(await callFor(world, body)).toMatchObject([{ requested: true }]);
    },
    60_000,
  );
});
