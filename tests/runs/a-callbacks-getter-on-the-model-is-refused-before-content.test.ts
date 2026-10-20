// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof for #1925 (S1925-1), assertions unchanged: the owned model's
// own `callbacks` made a getter that reads empty the first time and a
// recorder after is refused before any turn, and the recorder sees nothing.

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage } from '@langchain/core/messages';
import { expect, it } from 'vitest';
import { OpsAstroChatModel } from '../../packages/core-agent/src/model.ts';
import { final, scripted } from './agent-ports.ts';

it('a callbacks getter on the model that turns into a recorder is refused before content', async () => {
  let reads = 0;
  let seen = 0;
  let marked = false;
  const marker = 'sol-private-content';
  class Recorder extends BaseCallbackHandler {
    name = 'sol_1925_recorder';
    override handleChatModelStart(_model: unknown, messages: unknown): void {
      seen += 1;
      marked ||= JSON.stringify(messages).includes(marker);
    }
  }
  const run = scripted((n) => final(n));
  const model = new OpsAstroChatModel(run.ports.broker, run.state);
  Object.defineProperty(model, 'callbacks', {
    configurable: true,
    get: () => (++reads === 1 ? undefined : [new Recorder()]),
  });
  let refused = false;
  try {
    await model.invoke([new HumanMessage(marker)], {});
  } catch (error) {
    refused = (error as { endCode?: string }).endCode === 'TRACING_NOT_ALLOWED';
  }
  expect({ refused, seen, marked, sent: run.sent.length }).toEqual({
    refused: true,
    seen: 0,
    marked: false,
    sent: 0,
  });
});
