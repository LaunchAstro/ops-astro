// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan, carried to the M5: the prompt leaves the machine
// when the runner starts Codex's turn, so that is where the send deadline
// (`x-ops-send-by`) is checked. A call whose preparation (the child, its
// account, its usage, its thread) runs past the deadline is answered
// SEND_LAPSED and its turn is never started. One that starts in time says so
// first, with a `sent` line, before any piece.

import { describe, expect, it } from 'vitest';
import { answerOf, ndjson, runnerWorld } from './runner-world.ts';

const { start, call } = runnerWorld();
const message = { fields: { message: 'What is on the board today?' }, stream: true };

describe("a streamed call's send deadline", () => {
  it('starts no turn when the preparation runs past it, and says SEND_LAPSED', async () => {
    const { w, r } = await start();
    w.knobs({ prepMs: 400 });
    const reply = await call(r, message, {
      headers: { 'x-ops-send-by': String(Date.now() + 100) },
    });
    expect(ndjson(reply.raw)).not.toContainEqual({ sent: true });
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'SEND_LAPSED' });
    expect(w.asked()).toEqual([]);
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('says `sent` once the turn is started inside it, before any piece', async () => {
    const { r } = await start();
    const reply = await call(r, message, {
      headers: { 'x-ops-send-by': String(Date.now() + 5_000) },
    });
    const lines = ndjson(reply.raw);
    expect(lines[0]).toEqual({ sent: true });
    expect(lines[1]).toEqual({ piece: 'Two tasks' });
    expect(answerOf(reply.raw)).toMatchObject({ text: 'Two tasks are due.', code: null });
  });

  it.each(['soon', '-5', '1.5', ''])('refuses a deadline of %j as a bad request', async (value) => {
    const { w, r } = await start();
    const reply = await call(r, message, { headers: { 'x-ops-send-by': value } });
    expect(reply.status).toBe(400);
    expect(w.asked()).toEqual([]);
  });
});
