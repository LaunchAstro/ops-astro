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
//   Core then runs a model of its own (`BrokerTurns`), built here and never
//   handed out, with no callbacks, on messages rebuilt from their stored
//   form, and checks again just before it configures callbacks: nothing a
//   caller sets on this model, or runs after the guard, reaches them.

import type { Callbacks } from '@langchain/core/callbacks/manager';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  type AIMessageChunk,
  type BaseMessage,
  coerceMessageLikeToMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import type { ChatResult, LLMResult } from '@langchain/core/outputs';
import { BrokerTurns, refused, type BrokerPort, type OpsAstroCallOptions } from './broker-turns.ts';
import { entryRefused, ownRefused } from './guard.ts';
import { RunEnd, type AttemptState } from './turn.ts';

export type { BrokerPort, Turn, TurnAnswer } from './broker-turns.ts';

export class OpsAstroChatModel extends BaseChatModel<OpsAstroCallOptions> {
  readonly #turns: BrokerTurns;
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
    this.#turns = new BrokerTurns(port, state);
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
    // Messages and options are read once, before the guard: each message is
    // rebuilt from its stored form, so core reads none of the caller's own.
    const turns = messages.map((list) =>
      mapStoredMessagesToChatMessages(
        mapChatMessagesToStoredMessages(list.map((message) => coerceMessageLikeToMessage(message))),
      ),
    );
    const asked = Array.isArray(options) ? [...options] : { ...options };
    if (entryRefused(Array.isArray(asked) ? {} : asked, callbacks) || ownRefused(this)) {
      throw refused(this.#state);
    }
    if (Array.isArray(asked)) return await this.#turns.generate(turns, asked);
    const { callbacks: _checked, ...handed } = asked;
    return await this.#turns.generate(turns, handed);
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

  /** Reached only by bypassing `generate`: core has configured callbacks, so nothing is sent. */
  async _generate(): Promise<ChatResult> {
    return await Promise.reject(refused(this.#state));
  }
}
