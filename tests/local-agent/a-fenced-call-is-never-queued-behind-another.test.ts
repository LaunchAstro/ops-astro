// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan, carried to the M5: the call's admission holds only
// until its send deadline (`x-ops-send-by`), so a call carrying one is never
// left waiting behind another in the runner's queue, where its authority could
// lapse unseen. It is answered MODEL_MACHINE_BUSY at once, and the model is
// never asked its prompt. A call without a deadline (the laptop's) still queues.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';
import type { World } from './world.ts';

const { start, call } = runnerWorld();
const first = { fields: { message: 'First question.' }, stream: true };
const second = { fields: { message: 'Second question.' }, stream: true };
const fenced = (): Record<string, string> => ({ 'x-ops-send-by': String(Date.now() + 5_000) });

/** Waits, at most two seconds, until the model has been asked something; whether it was. */
async function askedWithin(w: World): Promise<boolean> {
  for (let tries = 0; tries < 200 && w.asked().length === 0; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
    await sleep(10);
  }
  return w.asked().length > 0;
}

describe('a call that carries a send deadline, while another is in flight', () => {
  it('is answered MODEL_MACHINE_BUSY at once, and its prompt is never asked', async () => {
    const { w, r } = await start();
    const gate = join(w.agentHome, 'gate');
    w.knobs({ gate });
    const running = call(r, first, { headers: fenced() });
    expect(await askedWithin(w)).toBe(true);
    const busy = call(r, second, { headers: fenced() });
    // Answered within two seconds while the first still holds the runner: on a queueing runner, not at all.
    const answeredAtOnce = await Promise.race([busy, sleep(2_000).then(() => null)]);
    writeFileSync(gate, '');
    expect(answeredAtOnce && answerOf(answeredAtOnce.raw)).toMatchObject({
      text: '',
      code: 'MODEL_MACHINE_BUSY',
    });
    expect(answerOf((await running).raw)).toMatchObject({ code: null });
    await busy;
    expect(w.asked()).toEqual(['First question.']);
  });

  it('queues, as before, when it carries no deadline', async () => {
    const { w, r } = await start();
    const gate = join(w.agentHome, 'gate');
    w.knobs({ gate });
    const running = call(r, first);
    expect(await askedWithin(w)).toBe(true);
    const queued = call(r, second);
    writeFileSync(gate, '');
    await running;
    expect(answerOf((await queued).raw)).toMatchObject({ code: null });
    expect(w.asked()).toEqual(['First question.', 'Second question.']);
  });
});
