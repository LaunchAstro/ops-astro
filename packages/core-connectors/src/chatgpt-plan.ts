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

export interface PlanAsk {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly PlanTurn[];
}

/** The pinned body, keys in their one order, each turn rebuilt as `{ role, content }`. */
export function chatgptPlanBody(ask: PlanAsk): string {
  return JSON.stringify({
    model: ask.model,
    instructions: ask.instructions,
    input: ask.input.map((turn) => ({ role: turn.role, content: turn.content })),
    store: false,
    stream: true,
  });
}
