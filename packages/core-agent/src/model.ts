// SPDX-License-Identifier: AGPL-3.0-only
//
// The one chat model an agent is given (#1623 R4, design R4, R5 and R9). It
// holds no provider and no credential: each call is one `model.call` turn to
// the broker, through the port the runner hands it, and the broker sends,
// counts and charges it. Its answer comes back as the text and tool calls the
// broker returned, under the call's id.
//
// - No retry. `maxRetries: 0`, and `_generate` never goes through
//   `this.caller`, LangChain's retry helper, so nothing here sends twice.
// - One count. Every call, the graph's, a direct `invoke` and every binding
//   (`bindTools`, `withConfig`), takes its ordinal from the attempt's one
//   state, so they share the server's one limit (TEST M3).
// - No handlers. The constructor refuses callbacks (or core's
//   `callbackManager` alias), verbose output and tags or metadata, and
//   `generate`, which every entry reaches before core configures callbacks,
//   refuses anything `guard.ts` finds in the call's options or in the
//   model's own `callbacks` and `verbose`, however they were set (#1921),
//   including a getter or proxy that would read differently to core (#1925).

import type { CallbackManagerForLLMRun, Callbacks } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import type { EndCode, RunOutcome, ToolCall, TurnPart } from '../../core-wire/src/index.ts';
import { entryRefused, ownRefused } from './guard.ts';
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

interface OpsAstroCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly string[];
}

const refused = (state: AttemptState): RunEnd => {
  state.ended ??= new RunEnd('TRACING_NOT_ALLOWED', false);
  return state.ended;
};

export class OpsAstroChatModel extends BaseChatModel<OpsAstroCallOptions> {
  readonly #port: BrokerPort;
  readonly #state: AttemptState;

  constructor(
    port: BrokerPort,
    state: AttemptState,
    asked: Readonly<Record<string, unknown>> = {},
  ) {
    const handlerKeys = ['callbacks', 'callbackManager', 'verbose', 'tags', 'metadata'];
    if (handlerKeys.some((key) => asked[key] !== undefined)) {
      throw refused(state);
    }
    super({ maxRetries: 0, verbose: false });
    this.#port = port;
    this.#state = state;
  }

  _llmType(): string {
    return 'ops-astro-broker';
  }

  override async invoke(
    input: Parameters<BaseChatModel['invoke']>[0],
    options?: OpsAstroCallOptions,
  ): Promise<AIMessageChunk> {
    if (entryRefused(options)) throw refused(this.#state);
    return await super.invoke(input, options);
  }

  override async generate(
    messages: BaseMessage[][],
    options?: string[] | OpsAstroCallOptions,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    // Options are read once, so core configures the callbacks the guard saw.
    const asked = Array.isArray(options) ? [...options] : { ...options };
    if (entryRefused(Array.isArray(asked) ? {} : asked, callbacks) || ownRefused(this)) {
      throw refused(this.#state);
    }
    return await super.generate(messages, asked, callbacks);
  }

  override withConfig(
    config: Partial<OpsAstroCallOptions>,
  ): ReturnType<BaseChatModel['withConfig']> {
    if (entryRefused(config)) throw refused(this.#state);
    return super.withConfig(config);
  }

  /** The agent's tools, by name; one the catalogue does not offer ends the run here. */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<OpsAstroCallOptions>,
  ): ReturnType<BaseChatModel['withConfig']> {
    const names = tools.map((tool) => String((tool as { name?: unknown }).name));
    if (names.some((name) => !this.#state.catalogue.includes(name))) {
      this.#state.ended ??= new RunEnd('TOOL_NOT_CATALOGUED', false);
      throw this.#state.ended;
    }
    return this.withConfig({ ...kwargs, tools: names });
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
