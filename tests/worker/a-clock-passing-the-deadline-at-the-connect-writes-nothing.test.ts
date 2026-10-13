// SPDX-License-Identifier: AGPL-3.0-only
//
// A clock that passes the deadline between the check after the lookup and
// the socket's connect writes nothing: the gate is read again at the connect,
// on a fresh socket of its own even when a connected keep-alive socket to the
// same model sits in the pool.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDestinations, send } from '../../packages/core-custody/src/egress.ts';
import { chatRequest } from './model-agent-world.ts';
import { ollamaOnLoopback, type LoopbackOllama } from './ollama-on-loopback.ts';

let ollama: LoopbackOllama | undefined;

afterEach(async () => {
  await ollama?.close();
  ollama = undefined;
});

/** A clock inside the deadline for the check after the lookup, past it from then on. */
function passingAt(deadlineAt: number): () => number {
  let reads = 0;
  return (): number => {
    reads += 1;
    return reads === 1 ? deadlineAt : deadlineAt + 1;
  };
}

describe('the clock at the connect', () => {
  it('a lookup inside the deadline and a connect past it writes nothing', async () => {
    ollama = await ollamaOnLoopback();
    const parsed = parseDestinations([{ key: 'ollama', origin: ollama.origin }]);
    if (!parsed.ok) throw new Error('the case listed a malformed destination');
    const deadlineAt = Date.now() + 3_000;
    const written: string[] = [];
    const outcome = await send(parsed.destinations, chatRequest(), null, undefined, undefined, {
      deadlineAt,
      now: passingAt(deadlineAt),
      onWritten: () => written.push('written'),
    });
    await sleep(100);
    expect(outcome).toStrictEqual({ ok: false, fault: 'lapsed', status: null });
    expect(ollama.seen).toHaveLength(0);
    expect(written).toStrictEqual([]);
  });

  it('beside a pooled keep-alive socket to the same model, the gated send still waits for its own connect', async () => {
    ollama = await ollamaOnLoopback();
    const parsed = parseDestinations([{ key: 'ollama', origin: ollama.origin }]);
    if (!parsed.ok) throw new Error('the case listed a malformed destination');
    // An ungated send leaves a connected socket in the pool.
    const first = await send(parsed.destinations, chatRequest(), null);
    expect(first.ok).toBe(true);
    const deadlineAt = Date.now() + 3_000;
    const outcome = await send(parsed.destinations, chatRequest(), null, undefined, undefined, {
      deadlineAt,
      now: passingAt(deadlineAt),
    });
    await sleep(100);
    expect(outcome).toStrictEqual({ ok: false, fault: 'lapsed', status: null });
    expect(ollama.seen).toHaveLength(1);
  });
});
