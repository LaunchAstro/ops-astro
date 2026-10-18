// SPDX-License-Identifier: AGPL-3.0-only
//
// The model core runs for each agent turn (#1925): `OpsAstroChatModel` builds
// it, keeps it private and hands it each call only after its guard, with no
// callbacks. Built with none, verbose off and no cache, and never handed
// out, so no caller can set a handler on it. Each call is one broker turn
// through the port; `_generate` never goes through `this.caller`.

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import type { EndCode, RunOutcome, ToolCall, TurnPart } from '../../core-wire/src/index.ts';
import { entryRefused } from './guard.ts';
import { keepAnswer, partsOf, RunEnd, type AttemptState } from './turn.ts';

/** One turn as the broker is sent it. */
export interface Turn {
  readonly turnOrdinal: number;
  readonly tools: readonly string[];
  readonly parts: readonly TurnPart[];
}

/** The broker's answer: words and tool calls under their call, or the stop it recorded. */
export type TurnAnswer =
  | {
      readonly callId: string;
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
      /** Set when this settlement ended the attempt: the limit-th call, `call_limit`. */
      readonly terminal?: RunOutcome;
    }
  | { readonly stopped: EndCode; readonly recorded: boolean };

export interface BrokerPort {
  readonly turn: (turn: Turn) => Promise<TurnAnswer>;
}

export interface OpsAstroCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly string[];
}

/** Ends the attempt `TRACING_NOT_ALLOWED`: a handler, flag, hook or tracing run tree is there. */
export const refused = (state: AttemptState): RunEnd => {
  state.ended ??= new RunEnd('TRACING_NOT_ALLOWED', false);
  return state.ended;
};

/** The model core runs for each turn: no callbacks, no verbose output, no cache, never handed out. */
export class BrokerTurns extends BaseChatModel<OpsAstroCallOptions> {
  readonly #port: BrokerPort;
  readonly #state: AttemptState;

  constructor(port: BrokerPort, state: AttemptState) {
    super({ maxRetries: 0, verbose: false });
    this.#port = port;
    this.#state = state;
  }

  _llmType(): string {
    return 'ops-astro-broker';
  }

  /**
   * Core's last step before it configures callbacks, after it has merged the
   * inherited config: the guard again, so nothing a caller's code did after
   * the first check, a hook planted included, reaches the callbacks (#1925).
   */
  override async _generateUncached(
    ...call: Parameters<BaseChatModel['_generateUncached']>
  ): Promise<LLMResult> {
    if (entryRefused(call[2])) throw refused(this.#state);
    // oxlint-disable-next-line no-underscore-dangle -- the name is core's own
    return await super._generateUncached(...call);
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _run?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const state = this.#state;
    const parts = partsOf(state, messages);
    const turnOrdinal = state.calls;
    state.calls += 1;
    const tools = options.tools ?? [];
    const answer = await this.#port.turn({ turnOrdinal, tools, parts });
    if ('stopped' in answer) {
      state.ended ??= new RunEnd(answer.stopped, answer.recorded);
      throw state.ended;
    }
    keepAnswer(state, answer.callId, answer.text, answer.toolCalls);
    if (answer.terminal !== undefined) {
      state.ended ??= new RunEnd('CALL_LIMIT_REACHED', true, answer.terminal);
      throw state.ended;
    }
    const message = new AIMessage({
      id: answer.callId,
      content: answer.text,
      tool_calls: answer.toolCalls.map((call) => ({ ...call, type: 'tool_call' as const })),
    });
    return { generations: [{ text: answer.text, message }] };
  }
}
