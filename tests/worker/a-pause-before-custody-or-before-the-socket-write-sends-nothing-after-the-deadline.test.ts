// SPDX-License-Identifier: AGPL-3.0-only
//
// The send deadline is the agent's accept plus W, and it is checked last at
// the socket: a pause anywhere before the write (in the agent, between the
// agent and custody, in the lookup before the connect, at the connect) ends
// with nothing written, a sealed `refused` `SEND_LAPSED`, and no chat parsed
// by the stand-in Ollama. Inside the deadline, exactly one chat is.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/agent.ts';
import {
  parseDestinations,
  send,
  type Destination,
} from '../../packages/core-custody/src/egress.ts';
import { standInOllama, streamedLines, type StandIn } from '../api/ollama-stand-in-fixture.ts';
import { chatRequest, openAgentWorld, WORDS, type AgentWorld } from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;
let ollama: StandIn | undefined;

afterEach(async () => {
  await world?.close();
  await ollama?.close();
  world = undefined;
  ollama = undefined;
});

describe('the agent', () => {
  it(
    'a request heard after the deadline on its own clock goes to no custody',
    async () => {
      let skew = 0;
      world = await openAgentWorld({ now: () => Date.now() + skew });
      const call = await world.call();
      skew = SEND_WINDOW_MS + 1_000;
      await call.line.send('request', call.seal('request', call.body()));
      const [refused] = await call.until('refused');
      expect(world.ollama.seen.length).toBe(0);
      expect(world.handed).toStrictEqual([]);
      expect(refused?.body).toStrictEqual({ code: 'SEND_LAPSED' });
    },
    WAIT,
  );

  it(
    'a pause between the agent and custody past the deadline writes nothing',
    async () => {
      // The accept is stamped so its deadline is 100 ms of real time away; the hand-over then waits 300.
      world = await openAgentWorld({
        now: () => Date.now() - (SEND_WINDOW_MS - 100),
        wrap: (custody) => ({
          dispatch: async (request, gate, onPiece) => {
            await sleep(300);
            return await custody.dispatch(request, gate, onPiece);
          },
        }),
      });
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body()));
      const [refused] = await call.until('refused');
      expect(world.ollama.seen.length).toBe(0);
      expect(refused?.body).toStrictEqual({ code: 'SEND_LAPSED' });
      expect(call.heard.filter((heard) => heard.event === 'written')).toStrictEqual([]);
    },
    WAIT,
  );
});

describe('the agent inside its deadline', () => {
  it(
    'control: inside the deadline the chat is written once, and said so',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body()));
      await call.until('answer');
      expect(world.ollama.seen.length).toBe(1);
      expect(call.heard.filter((heard) => heard.event === 'written')).toHaveLength(1);
    },
    WAIT,
  );
});

describe('custody', () => {
  it(
    'a dispatch whose deadline passed before it reached custody writes nothing',
    async () => {
      world = await openAgentWorld();
      const written: string[] = [];
      const gate = { deadlineAt: Date.now() - 1, onWritten: () => written.push('written') };
      const outcome = await world.custody.dispatchBefore('ollama_key', chatRequest(), gate);
      expect(world.ollama.seen.length).toBe(0);
      expect(outcome).toStrictEqual({ kind: 'refused', started: false, code: 'SEND_LAPSED' });
      expect(written).toStrictEqual([]);
    },
    WAIT,
  );

  it(
    'control: inside its deadline custody writes once and says so before the answer',
    async () => {
      world = await openAgentWorld();
      const order: string[] = [];
      const gate = { deadlineAt: Date.now() + 3_000, onWritten: () => order.push('written') };
      const outcome = await world.custody.dispatchBefore('ollama_key', chatRequest(), gate, () =>
        order.push('piece'),
      );
      order.push(outcome.kind);
      expect(world.ollama.seen.length).toBe(1);
      expect(order[0]).toBe('written');
      expect(order.at(-1)).toBe('answered');
    },
    WAIT,
  );
});

const listed = (origin: string): ReadonlyMap<string, Destination> => {
  const parsed = parseDestinations([{ key: 'ollama', origin }]);
  if (!parsed.ok) throw new Error('the case listed a malformed destination');
  return parsed.destinations;
};

/** A lookup that answers loopback after 200 ms. */
async function slowLookup(): Promise<readonly { address: string; family: number }[]> {
  await sleep(200);
  return [{ address: '127.0.0.1', family: 4 }];
}

describe('egress', () => {
  it('a lookup that ends past the deadline connects to nothing', async () => {
    ollama = await standInOllama();
    const port = new URL(ollama.origin).port;
    const outcome = await send(
      listed(`http://localhost:${port}`),
      chatRequest(),
      null,
      slowLookup,
      undefined,
      { deadlineAt: Date.now() + 50 },
    );
    expect(ollama.seen.length).toBe(0);
    expect(outcome).toStrictEqual({ ok: false, fault: 'lapsed', status: null });
  });

  it('a clock past the deadline at the connect writes nothing', async () => {
    ollama = await standInOllama();
    const deadlineAt = Date.now() + 3_000;
    const written: string[] = [];
    const outcome = await send(listed(ollama.origin), chatRequest(), null, undefined, undefined, {
      deadlineAt,
      now: () => deadlineAt + 1,
      onWritten: () => written.push('written'),
    });
    await sleep(100);
    expect(ollama.seen.length).toBe(0);
    expect(outcome).toStrictEqual({ ok: false, fault: 'lapsed', status: null });
    expect(written).toStrictEqual([]);
  });

  it('control: at the deadline itself the request is written once', async () => {
    ollama = await standInOllama();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const deadlineAt = Date.now() + 3_000;
    const written: string[] = [];
    const outcome = await send(listed(ollama.origin), chatRequest(), null, undefined, undefined, {
      deadlineAt,
      now: () => deadlineAt,
      onWritten: () => written.push('written'),
    });
    expect(ollama.seen.length).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(written).toStrictEqual(['written']);
  });
});
