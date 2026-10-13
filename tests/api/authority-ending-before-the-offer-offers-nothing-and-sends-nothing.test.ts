// SPDX-License-Identifier: AGPL-3.0-only
//
// A purge, a client linked to the page task, the agent deactivated or its
// membership closed, each committed on another connection after the call was
// written and before its offer judgement: the offer is refused, the doorbell
// never rings, nothing is sent, the call is released.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import {
  ask,
  callFor,
  deactivateAgent,
  leaveMembership,
  repliesTo,
  stored,
} from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Change = 'purged' | 'client linked' | 'agent deactivated' | 'membership left';

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('authority ending before the offer', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_before_offer');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Fine.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** A task to ask on, and how to link a client to it as the person does. */
  async function aTask(): Promise<{ readonly task: string; readonly link: () => Promise<void> }> {
    const { w } = world;
    const made = await w.as(w.owner, 'task.create', { fields: { title: `Plan ${randomUUID()}` } });
    const task = String(made.body['recordId']);
    const client = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, client, w.owner);
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
    const link = async (): Promise<void> => {
      // The person's own command, on the API, while the function waits at its join.
      const linked = await w.as(w.owner, 'task.set_party', {
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: made.body['revision'],
        fields: { client },
      });
      expect(linked.status).toBe(200);
    };
    return { task, link };
  }

  /** The call on `topic` (its line), changed on a connection of its own. */
  const commit = async (change: Change, topic: string, link: () => Promise<void>) => {
    const k = topic.split(':').at(-1) ?? '';
    if (change === 'client linked') return await link();
    await world.w.fixture.db.app.withBusiness(world.w.fixture.business, async (tx) => {
      if (change === 'agent deactivated') await deactivateAgent(world, tx);
      if (change === 'membership left') await leaveMembership(tx, k);
      if (change === 'purged') {
        await tx.query(
          `update public.conversations v
              set body_purged_at = clock_timestamp(), purge_operation_id = $3
             from public.model_calls c
            where c.business_id = $1 and c.id = $2
              and v.business_id = c.business_id and v.id = c.conversation_id`,
          [tx.businessId, k, randomUUID()],
        );
      }
    });
  };

  it.each(['purged', 'client linked', 'agent deactivated', 'membership left'] as const)(
    '%s before the offer judgement: nothing offered, nothing sent, released',
    async (change) => {
      const body = `Offered? (${change})`;
      const { task, link } = await aTask();
      world.beforeJoin.run = async (topic) => await commit(change, topic, link);
      const events = await (await ask(world, body, undefined, task)).rest();
      expect(world.agent.accepted).toHaveLength(0);
      expect(world.ollama.seen).toHaveLength(0);
      expect(await stored(world)).toEqual([]);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: false, requested: false, actual: null },
      ]);
      expect(await repliesTo(world, body)).toBe(0);
      const said = outcome(events)['reply'] as { readonly answered?: boolean } | null | undefined;
      expect(said?.answered).not.toBe(true);
    },
    60_000,
  );
});
