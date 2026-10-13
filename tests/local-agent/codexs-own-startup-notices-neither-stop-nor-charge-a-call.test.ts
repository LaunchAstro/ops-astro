// SPDX-License-Identifier: AGPL-3.0-only
//
// GPT streamed (LA-1's runner): Codex 0.162.1's app-server says, straight
// after `initialize`, whether remote control is on. With it off (`disabled`),
// that is a quiet notice and the call goes on. With it on in any form, someone
// else could drive the session, so the call is stopped before the model is
// asked. And any call the grammar stops before its turn is sent (an unknown
// notice, remote control on) is charged nothing: the model was never asked.

import { describe, expect, it } from 'vitest';
import { answerOf, runnerWorld } from './runner-world.ts';

const { start, call } = runnerWorld();
const message = { fields: { message: 'Say hello.' }, stream: true };

describe("Codex's own notices before the turn", () => {
  it('lets a call through remote control reported off, as 0.162.1 reports it', async () => {
    const { w, r } = await start();
    w.knobs({ remoteControl: 'disabled' });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: 'Two tasks are due.', code: null });
    expect(w.asked()).toEqual(['Say hello.']);
  });

  it('still says GPT_SIGNED_OUT, charging nothing, after that notice', async () => {
    const { w, r } = await start();
    w.knobs({ remoteControl: 'disabled', signedOut: true });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'GPT_SIGNED_OUT' });
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it.each(['connecting', 'connected', 'errored'])(
    'stops a call with remote control %s before the model is asked, charging nothing',
    async (status) => {
      const { w, r } = await start();
      w.knobs({ remoteControl: status });
      const reply = await call(r, message);
      expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
      expect(w.asked()).toEqual([]);
      expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    },
  );

  it('charges nothing for a call stopped by a notice it does not know, before its turn', async () => {
    const { w, r } = await start();
    w.knobs({ afterInit: [['thread/somethingNew', {}]] });
    const reply = await call(r, message);
    expect(answerOf(reply.raw)).toMatchObject({ text: '', code: 'LOCAL_GPT_FAILED' });
    expect(w.asked()).toEqual([]);
    expect(w.ledger().at(-1)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
