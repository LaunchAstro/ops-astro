// SPDX-License-Identifier: AGPL-3.0-only
//
// OpenRouter (#1508): the outside provider of paid chat answers, for internal
// work only and only through the carve-out (`carriesOutside`). Its models are
// registered here in code and reviewed, never configured, each with the ids
// OpenRouter may name it by and its prices as OpenRouter's `max_price` takes
// them: US dollars per million tokens, as decimal strings, from OpenRouter's
// public model list (13 Oct 2026).
//
// The hold is the most one reply can cost, in AUD cents, at a fixed rate a
// little above the market's so the budget runs out before the credit does:
// every input token the body can hold (one per byte, plus the message frames)
// and every output token `max_tokens` allows.

export const OPENROUTER_PROVIDER: string = 'openrouter';
export const OPENROUTER_CONVERSATION_KEY: string = 'model.conversation_answer_openrouter';

/** The request body's most, in bytes: the context is trimmed to fit it. */
export const OPENROUTER_BODY_LIMIT: number = 48 * 1024;
/** The answer's most, in tokens: pinned in the request and checked by the model agent. */
export const OPENROUTER_MAX_TOKENS = 2_048;
/** Tokens beyond the body's bytes the message frames may add. */
const FRAME_TOKENS = 256;
/** AUD per US dollar, a reviewed constant: a change goes in a pull request with its reason. */
export const OPENROUTER_AUD_PER_USD = '1.60';

export interface OpenRouterModel {
  readonly id: string;
  /** The ids an answer from this model may name: the canonical one and its dated one. */
  readonly acceptedIds: readonly string[];
  /** US dollars per million tokens, sent unchanged as `max_price`. */
  readonly promptPerMillion: string;
  readonly completionPerMillion: string;
  /** The picker's words. */
  readonly label: string;
}

export const OPENROUTER_MODELS: readonly OpenRouterModel[] = [
  {
    id: 'anthropic/claude-haiku-5.5',
    acceptedIds: ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5-20261007'],
    promptPerMillion: '0.1',
    completionPerMillion: '0.5',
    label: 'Claude Haiku 5.5 (paid, internal only)',
  },
];

/** A decimal string as a whole number of millionths, refused if it has more places. */
function millionths(decimal: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(decimal);
  if (match === null) throw new Error(`not a price: ${decimal}`);
  return BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** Integer division rounded up. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * The most one reply on `model` can cost, in AUD cents, rounded up:
 * ceil(rate × 100 × (input × P_in + output × P_out) / 1,000,000), worked in
 * whole millionths so nothing rounds down.
 */
export function openrouterHoldMinor(model: OpenRouterModel): number {
  const input = BigInt(OPENROUTER_BODY_LIMIT + FRAME_TOKENS);
  const output = BigInt(OPENROUTER_MAX_TOKENS);
  // Millionths of a US dollar per million tokens, times tokens: millionths of a dollar × 10^6.
  const usd =
    input * millionths(model.promptPerMillion) + output * millionths(model.completionPerMillion);
  // × rate (millionths) × 100 cents, then back out of 10^6 (tokens) × 10^6 (price) × 10^6 (rate).
  const cents = usd * millionths(OPENROUTER_AUD_PER_USD) * 100n;
  return Number(ceilDiv(cents, 1_000_000n * 1_000_000n * 1_000_000n));
}

/** The registered model `id` names, if any. */
export const openrouterModel = (id: string | undefined): OpenRouterModel | undefined =>
  OPENROUTER_MODELS.find((model) => model.id === id);
