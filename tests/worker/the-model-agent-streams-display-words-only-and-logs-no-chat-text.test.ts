// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent reads Ollama's whole local stream and sends display words only:
// whole lines, in numbered pieces from 0, a leading thinking block never
// shown, however the bytes were cut. The first piece goes while Ollama is
// still writing. The sealed answer is custody's whole body, sent again every
// 2 s until `settled`, three times at most. Custody lost mid-answer sends no
// answer, so the call is held. The agent's log names kinds, never chat text.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import {
  foldOllamaStream,
  OLLAMA_DEFAULT_MODEL,
} from '../../packages/core-connectors/src/index.ts';
import { streamedLines } from './ollama-on-loopback.ts';
import { openAgentWorld, PROMPT, WORDS, type AgentWorld, type Call } from './model-agent-world.ts';

const WAIT = 20_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

const THOUGHT = ['<think>', 'the secret reasoning', '</think>'];
const SAID = ['\n\nTwo ', 'tasks ', 'at the café ', 'are due.'];

/** A thinking stream's bytes cut every `size`, mid-line and mid-character. */
function cutEvery(size: number): string[] {
  const bytes = Buffer.from(streamedLines(OLLAMA_DEFAULT_MODEL, [...THOUGHT, ...SAID]).join(''));
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += size)
    chunks.push(bytes.subarray(at, at + size).toString('latin1'));
  return chunks;
}

async function asked(call: Call): Promise<void> {
  await call.line.send('request', call.seal('request', call.body()));
}

const pieces = (call: Call) => call.heard.filter((heard) => heard.event === 'piece');

it.each([1, 5, 17])(
  'pieces cut every %i bytes show the words and no thinking',
  async (size) => {
    world = await openAgentWorld();
    world.ollama.reply = () => ({ status: 200, chunks: cutEvery(size), latin1: true });
    const call = await world.call();
    await asked(call);
    const [answer] = await call.until('answer');
    const shown = pieces(call);
    expect(shown.map((piece) => piece.seq)).toStrictEqual(shown.map((_piece, at) => at));
    const text = shown.map((piece) => (piece.body as { text: string }).text).join('');
    expect(text).toBe('Two tasks at the café are due.');
    expect(text).not.toMatch(/secret|think/u);
    const outcome = answer?.body as { kind: string; outbound: { ok: boolean; body: string } };
    expect(outcome.kind).toBe('answered');
    const folded = JSON.parse(foldOllamaStream(outcome.outbound.body) ?? '{}') as {
      message: { content: string };
    };
    expect(folded.message.content).toContain('are due.');
  },
  WAIT,
);

it(
  'the first piece goes while Ollama is still writing',
  async () => {
    world = await openAgentWorld();
    world.ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS),
      holdAfter: 3,
    });
    const call = await world.call();
    await asked(call);
    await Promise.race([world.ollama.midway(), sleep(3_000)]);
    const early = await call.until('piece', 1, 2_000);
    expect(early.length).toBeGreaterThan(0);
    expect(call.heard.filter((heard) => heard.event === 'answer')).toStrictEqual([]);
    world.ollama.resume();
    await call.until('answer');
  },
  WAIT,
);

it(
  'the answer is sent again every 2 s until settled, three times at most',
  async () => {
    world = await openAgentWorld();
    const call = await world.call();
    await asked(call);
    const answers = await call.until('answer', 4, 9_000);
    expect(answers).toHaveLength(4);
    expect(new Set(answers.map((answer) => answer.raw.mac)).size).toBe(1);
    await sleep(2_500);
    expect(call.heard.filter((heard) => heard.event === 'answer')).toHaveLength(4);
  },
  WAIT,
);

it(
  'settled stops the answer being sent again',
  async () => {
    world = await openAgentWorld();
    const call = await world.call();
    await asked(call);
    await call.until('answer');
    await call.line.send('settled', call.seal('settled', {}));
    await sleep(2_500);
    expect(call.heard.filter((heard) => heard.event === 'answer')).toHaveLength(1);
  },
  WAIT,
);

it(
  'custody lost mid-answer sends no answer and no refusal',
  async () => {
    world = await openAgentWorld();
    world.ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS),
      holdAfter: 2,
    });
    const call = await world.call();
    await asked(call);
    await Promise.race([world.ollama.midway(), sleep(3_000)]);
    await call.until('written');
    world.custody.kill();
    await sleep(1_000);
    world.ollama.resume();
    const ended = call.heard.filter(
      (heard) => heard.event === 'answer' || heard.event === 'refused',
    );
    expect(ended).toStrictEqual([]);
    expect(call.heard.map((heard) => heard.event)).toContain('started');
  },
  WAIT,
);

it(
  'the log names what happened and holds no chat text',
  async () => {
    world = await openAgentWorld();
    const call = await world.call();
    await asked(call);
    await call.until('answer');
    expect(world.logs.length).toBeGreaterThan(0);
    const logged = world.logs.join('\n');
    expect(logged).not.toContain(PROMPT);
    for (const word of WORDS) expect(logged).not.toContain(word.trim());
  },
  WAIT,
);
