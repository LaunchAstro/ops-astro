// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call is judged twice, at the offer and at the send, each after
// every lock it rests on and at the instant after them. A change that ends
// the call's authority while the judgement waits on one of those locks is
// seen: the person's own-conversation grant revoked, or their token's expiry
// passing, while the judgement waits on the agent's actor row. At the offer,
// nothing is offered: no doorbell rings, Ollama is asked nothing, and the call
// is released. At the send, the request is never recorded or sent. With no
// change while it waits, the call is offered, sent once and answered.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import {
  ask,
  callFor,
  holdAgent,
  judgementWaits,
  repliesTo,
  revokeOwn,
  stored,
} from './carried-schedules.ts';
import { tokenFor } from './fixture.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due.'];

type Change = 'grant revoked' | 'token expired' | 'nothing';

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a change during the carriage judgement', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_judgement_waits');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** Holds the judgement at the actor row, makes `change` while it waits, then lets it go on. */
  async function during(
    change: Change,
    body: string,
    at: 'offer' | 'send',
  ): Promise<{ readonly outcome: unknown }> {
    // A short-lived token, so its expiry can pass while the judgement waits.
    const token = await tokenFor(world.w.owner.presented.subject, { expiresIn: 4 });
    let holding: Promise<void> = Promise.resolve();
    const hold = async (): Promise<void> => {
      const held = await holdAgent(world);
      holding = (async () => {
        await judgementWaits(world, held);
        if (change === 'token expired') await sleep(4_500);
        await held.letGo(async (tx) => {
          if (change === 'grant revoked') await revokeOwn(world, tx);
        });
      })();
    };
    // Each hold is taken once the command has committed: at the function's join for the
    // offer, at the agent's accept for the send.
    if (at === 'send') world.agent.beforeAccept = hold;
    else world.beforeJoin.run = hold;
    const events = await (await ask(world, body, token)).rest();
    await holding;
    const outcome = JSON.parse(events.at(-1)?.data ?? '{}') as unknown;
    return { outcome };
  }

  it.each([
    ['grant revoked', 'offer'],
    ['token expired', 'offer'],
    ['grant revoked', 'send'],
    ['token expired', 'send'],
  ] as const)(
    '%s while the %s judgement waits: nothing sent, the call released',
    async (change, at) => {
      const body = `What is due? (${change}, ${at})`;
      const { outcome } = await during(change, body, at);
      expect(world.agent.sent).toHaveLength(0);
      expect(world.ollama.seen).toHaveLength(0);
      const [call] = await callFor(world, body);
      // A send is recorded before its judgement: refused there, `request_at` is set and nothing sent.
      expect(call).toMatchObject({ state: 'released', requested: at === 'send' });
      if (at === 'offer') {
        expect(call?.offered).toBe(false);
        expect(await stored(world)).toEqual([]);
      }
      expect(await repliesTo(world, body)).toBe(0);
      expect(outcome).toMatchObject({ reply: { answered: false } });
    },
    60_000,
  );

  it.each(['offer', 'send'] as const)(
    'with nothing changed while the %s judgement waits, the call is offered, sent once and answered',
    async (at) => {
      const body = `What is due? (nothing, ${at})`;
      const { outcome } = await during('nothing', body, at);
      expect(world.agent.sent).toHaveLength(1);
      expect(world.ollama.seen).toHaveLength(1);
      expect(await callFor(world, body)).toEqual([
        { state: 'settled', offered: true, requested: true, actual: 0 },
      ]);
      expect(outcome).toMatchObject({ reply: { answered: true, body: 'Two tasks are due.' } });
      expect(await repliesTo(world, body)).toBe(1);
    },
    60_000,
  );
});
