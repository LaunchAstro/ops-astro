// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT on the owner's plan: before a streamed call starts a thread, the runner
// asks Codex which account it is signed in to. No account, or one that is not
// the ChatGPT plan's, asks the model nothing and says so by its own code; no
// other model is tried. A turn refused as unauthorized before the model gave
// anything is the same; after it gave something, the call is unknown and charged.

import { describe, expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';

const { logged, start, call } = runnerWorld();
const message = { fields: { message: 'What is on the board today?' }, stream: true };
/** What a call with this message is charged before codex runs: 50,000 and its 27 bytes. */
const NEED = 50_027;

describe('a runner signed out of the ChatGPT plan', () => {
  it.each([
    ['no account', { signedOut: true }],
    ['an API key', { account: { type: 'apiKey' } }],
  ])(
    'asks the model nothing when Codex holds %s, and says GPT_SIGNED_OUT',
    async (_label, knobs) => {
      const { w, r } = await start();
      w.knobs(knobs);
      const reply = await call(r, message);
      expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'GPT_SIGNED_OUT' });
      expect(w.asked()).toEqual([]);
      expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
      expect(logged.join('\n')).toContain('GPT_SIGNED_OUT');
    },
  );

  it('says GPT_SIGNED_OUT, charging nothing, for a turn refused before the model gave anything', async () => {
    const { w, r } = await start();
    w.knobs({
      deltas: null,
      noUsage: true,
      turnError: { message: 'unauthorized', codexErrorInfo: 'unauthorized' },
    });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'GPT_SIGNED_OUT' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('is unknown, and charged, for a turn refused after the model gave something', async () => {
    const { w, r } = await start();
    w.knobs({
      deltas: ['Two'],
      noUsage: true,
      turnError: { message: 'unauthorized', codexErrorInfo: 'unauthorized' },
    });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: NEED });
  });
});
