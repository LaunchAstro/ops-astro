// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for #1911 (S1911-3, #1921), assertions unchanged: a recorder
// assigned to the owned model's own `callbacks` after construction, then an
// invoke with empty options, is refused before any turn, and the recorder
// sees nothing. It prints booleans and counts only.

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage } from '@langchain/core/messages';
import { expect, it } from 'vitest';
import { OpsAstroChatModel } from '../../packages/core-agent/src/index.ts';
import { final, scripted } from './agent-ports.ts';

it('a recorder set on the model after construction is refused before it sees content', async () => {
  let seen = 0;
  let marked = false;
  const marker = `OA-MARKER-${process.pid}`;
  class Recorder extends BaseCallbackHandler {
    name = 'sol_model_owned_recorder';
    override handleChatModelStart(_model: unknown, messages: unknown): void {
      seen++;
      marked ||= JSON.stringify(messages).includes(marker);
    }
  }
  const run = scripted((n) => final(n));
  const model = new OpsAstroChatModel(run.ports.broker, run.state);
  model.callbacks = [new Recorder()];
  let refused = false;
  try {
    await model.invoke([new HumanMessage(marker)], {});
  } catch (error) {
    refused = (error as { endCode?: unknown }).endCode === 'TRACING_NOT_ALLOWED';
  }
  expect({ refused, seen, marked, sent: run.sent.length }).toEqual({
    refused: true,
    seen: 0,
    marked: false,
    sent: 0,
  });
});
