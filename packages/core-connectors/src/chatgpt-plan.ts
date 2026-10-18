// SPDX-License-Identifier: AGPL-3.0-only
//
// The `chatgpt-plan` route (#1620 P4): the owner's own ChatGPT plan, answered
// from the M5. Custody there holds the plan's token (`plan-token.ts`) and
// calls the public Responses endpoint at `https://api.openai.com` with it;
// nothing here holds or names a token.
//
// The request is pinned. Its body is exactly `model`, `instructions`,
// `input`, `store: false` and `stream: true`, written in that order by
// `chatgptPlanBody`, so the bytes captured are the bytes checked: no
// temperature, no token cap, no stored conversation, nothing the plan's
// Responses route does not take. The model is one of the plan's two. Each
// input turn is `{ role, content }`, the role `user` or `assistant`; the
// instructions travel once, in `instructions`. Tools are not taken yet.

import type { AdapterRequest, ModelAnswer, ModelOperationDeclaration } from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The route's provider key and the destination custody sends it to. */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt_plan';

/** The public Responses endpoint's one path. */
export const CHATGPT_PLAN_PATH = '/v1/responses';

/** The only addresses the route's custody reaches: the Responses endpoint and the plan's issuer. */
export const CHATGPT_PLAN_ORIGIN = 'https://api.openai.com';
export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';

/** The plan's two models: the smaller for basic checks, the larger for harder ones (spec #1612 story 20). */
export const CHATGPT_PLAN_MODELS: readonly string[] = ['gpt-6.1-luna', 'gpt-6.1-sol'];

/** The most bytes one request body may hold. */
export const CHATGPT_PLAN_BODY_LIMIT: number = 64 * 1024;

/** The longest a plan call may take, and the largest streamed answer custody reads. */
export const CHATGPT_PLAN_TIMEOUT_MS = 120_000;
export const CHATGPT_PLAN_ANSWER_BYTES: number = 1024 * 1024;

export interface PlanTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface PlanCall {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface PlanCallOutput {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

export type PlanItem = PlanTurn | PlanCall | PlanCallOutput;

export interface PlanTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface PlanAsk {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly PlanItem[];
  readonly tools?: readonly PlanTool[];
}

/** The deepest and largest a tool's `parameters` may be. */
export const CHATGPT_PLAN_PARAMETERS_DEPTH = 16;
export const CHATGPT_PLAN_PARAMETERS_BYTES: number = 16 * 1024;

/** A call the plan's model made, as the answer reader gives it back. */
export interface PlanToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

export function chatgptPlanAdapter(
  _values: Readonly<Record<string, string>>,
  _operationId?: string,
  _model?: string,
): AdapterRequest {
  return { path: CHATGPT_PLAN_PATH, method: 'POST', body: '' };
}

export const CHATGPT_PLAN_CONVERSATION: ModelOperationDeclaration = {
  ...CONVERSATION_ANSWER,
  key: 'model.chatgpt_plan_answer',
};

export function readChatgptPlanAnswer(_body: unknown): ModelAnswer | undefined {
  return undefined;
}

export function readChatgptPlanToolCalls(_body: unknown): readonly PlanToolCall[] | undefined {
  return undefined;
}

/** The pinned body, keys in their one order, each turn rebuilt as `{ role, content }`. */
export function chatgptPlanBody(ask: PlanAsk): string {
  return JSON.stringify({
    model: ask.model,
    instructions: ask.instructions,
    input: ask.input.map((turn) => ({
      role: (turn as PlanTurn).role,
      content: (turn as PlanTurn).content,
    })),
    store: false,
    stream: true,
  });
}
