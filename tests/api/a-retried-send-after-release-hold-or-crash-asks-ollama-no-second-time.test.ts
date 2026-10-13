// SPDX-License-Identifier: AGPL-3.0-only
//
// One message, one model call, durably. A person's message is asked once; the
// same message handed to the exchange again, on another API instance whose
// process holds nothing of the first (its own exchange, its own custody), makes
// no second call, whatever became of the first:
//
//   (a) released (Ollama refused it): the answer ended, send the message again;
//   (b) held (Ollama dropped the socket mid-answer): the same;
//   (c) still with the model, its first asker gone quiet: still answering;
//   (d) answered, the reply kept: the reply.
//
// Each asserts the stand-in Ollama's request count and the call rows the
// message has. Control: a new message is a new call.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  chatAnswer,
  ollamaBroker,
  says,
  standInOllama,
  type StandIn,
} from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:27b-mlx';

const within = async <T>(ms: number, work: Promise<T>): Promise<T> =>
  await Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`still waiting after ${String(ms)} ms`);
    }),
  ]);

/** Ollama answering every request with `status`. */
const failWith = (status: number) => () => ({ status, body: '{"error":"no"}' });

type Instance = Awaited<ReturnType<typeof ollamaBroker>>;

describe.skipIf(serverUrl === undefined)(
  'a message sent again asks the model no second time',
  // eslint-disable-next-line max-lines-per-function -- one stand-in, two instances, one world
  () => {
    let ollama: StandIn;
    let first: Instance;
    let second: Instance;
    let w: ConversationWorld;

    beforeAll(async () => {
      vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
      ollama = await standInOllama();
      // Two API instances: each its own exchange (no shared in-process map) and its own custody.
      first = await ollamaBroker(ollama.origin);
      second = await ollamaBroker(ollama.origin);
      const fixture = await createApiFixture('one_call_per_message');
      w = await conversationWorld({
        fixture,
        api: composedWith(fixture, async () => await Promise.resolve(null)),
      });
    }, 180_000);

    afterAll(async () => {
      ollama?.open();
      await first?.stop();
      await second?.stop();
      await ollama?.close();
      await w?.drop();
      vi.unstubAllEnvs();
    });

    async function question(body: string) {
      const opened = await w.as(w.owner, 'conversation.start', { body });
      return {
        conversationId: String(detail(opened)['conversationId']),
        messageId: String(detail(opened)['messageId']),
      };
    }

    const ask = async (on: Instance, asked: { conversationId: string; messageId: string }) =>
      await within(
        20_000,
        on.exchange(w.fixture.db.app, w.fixture.business, w.owner.presented, asked),
      );

    const callsFor = async (conversationId: string) =>
      await w.fixture.db.admin.execute<{ readonly state: string }>(
        `select state from public.model_calls where conversation_id = $1 order by started_at`,
        [conversationId],
      );

    it.each([
      ['released', failWith(404), 'released'],
      ['held', () => 'close' as const, 'liability_unknown'],
    ])(
      'after the call was %s, the same message asks Ollama no second time and says the answer ended',
      async (_name, reply, state) => {
        const asked = await question(`What ended (${state})?`);
        const before = ollama.seen.length;
        ollama.reply = reply;
        try {
          const once = await ask(first, asked);
          expect(once).toMatchObject({ answered: false });
        } finally {
          ollama.reply = (model) => chatAnswer(model, says(model));
        }
        expect(await callsFor(asked.conversationId)).toEqual([{ state }]);
        const again = await ask(second, asked);
        expect(ollama.seen).toHaveLength(before + 1);
        expect(await callsFor(asked.conversationId)).toEqual([{ state }]);
        expect(again).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
      },
      60_000,
    );

    it('while the first asker still waits on the model, the same message is told it is still answering', async () => {
      const asked = await question('Still on its way?');
      const before = ollama.seen.length;
      const quiet = connect(w.fixture.db.appUrl, { source: 'runtime' });
      ollama.shut();
      let waiting: Promise<ConversationReply | null> | undefined;
      try {
        waiting = first.exchange(quiet, w.fixture.business, w.owner.presented, asked);
        await ollama.arrived(before + 1);
        const again = await ask(second, asked);
        expect(ollama.seen).toHaveLength(before + 1);
        expect(again).toMatchObject({ answered: false, code: 'STILL_ANSWERING' });
        expect(await callsFor(asked.conversationId)).toEqual([{ state: 'dispatched' }]);
      } finally {
        ollama.open();
        await waiting?.catch(() => null);
        await quiet.close();
      }
      expect(await callsFor(asked.conversationId)).toEqual([{ state: 'settled' }]);
    }, 60_000);

    it('once answered, the same message gets the kept reply and a new message is a new call', async () => {
      const asked = await question('What is due today?');
      const before = ollama.seen.length;
      const answered = await ask(first, asked);
      expect(answered).toMatchObject({ answered: true, body: says(QWEN) });
      expect(await ask(second, asked)).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen).toHaveLength(before + 1);
      expect(await callsFor(asked.conversationId)).toEqual([{ state: 'settled' }]);
      // Control: the person sends again, a new message, and it is a new call.
      const next = await w.as(w.owner, 'conversation.message', {
        conversationId: asked.conversationId,
        body: 'And tomorrow?',
      });
      const nextAsked = {
        conversationId: asked.conversationId,
        messageId: String(detail(next)['messageId']),
      };
      expect(await ask(second, nextAsked)).toMatchObject({ answered: true });
      expect(ollama.seen).toHaveLength(before + 2);
      expect(await callsFor(asked.conversationId)).toEqual([
        { state: 'settled' },
        { state: 'settled' },
      ]);
    }, 60_000);
  },
);
