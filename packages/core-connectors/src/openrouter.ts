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
//
// The request is pinned: exactly the keys below, `max_price` per million
// tokens as declared, no fallback provider, no data collection, so OpenRouter
// cannot charge more than the hold. Custody decodes OpenRouter's stream itself
// (`stream-decode.ts`) and hands the broker its pieces and one folded body;
// the price is the cost OpenRouter reports in it, never an estimate.

import { conversationInstructions, promptPage, promptSites } from './conversation-prompt.ts';
import { earlierTurns, type Turn } from './ollama.ts';
import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
  type PieceReader,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

export const OPENROUTER_PROVIDER: string = 'openrouter';
export const OPENROUTER_CONVERSATION_KEY: string = 'model.conversation_answer_openrouter';

/** The request body's most, in bytes: the context is trimmed to fit it. */
export const OPENROUTER_BODY_LIMIT: number = 48 * 1024;
/** The answer's most, in tokens: pinned in the request and checked by the model agent. */
export const OPENROUTER_MAX_TOKENS = 2_048;
export const OPENROUTER_PATH = '/api/v1/chat/completions';
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

/** The model asked for, or the first registered; a model not registered is no request. */
function modelOf(id: string | undefined): OpenRouterModel {
  const model = id === undefined ? OPENROUTER_MODELS[0] : openrouterModel(id);
  if (model === undefined) throw new Error('not a registered OpenRouter model');
  return model;
}

/** The pinned request: the instructions, the earlier turns and the message, and nothing to widen the charge. */
export function openrouterRequest(
  values: Readonly<Record<string, string>>,
  _operationId?: string,
  model?: string,
): AdapterRequest {
  const chosen = modelOf(model);
  const messages: readonly Turn[] = [
    {
      role: 'system',
      content: conversationInstructions(promptPage(values['page']), promptSites(values['page'])),
    },
    ...earlierTurns(values['earlier']),
    { role: 'user', content: values['message'] ?? '' },
  ];
  return {
    path: OPENROUTER_PATH,
    method: 'POST',
    body: JSON.stringify({
      model: chosen.id,
      messages,
      stream: true,
      max_tokens: OPENROUTER_MAX_TOKENS,
      usage: { include: true },
      provider: {
        max_price: { prompt: chosen.promptPerMillion, completion: chosen.completionPerMillion },
        data_collection: 'deny',
        allow_fallbacks: false,
      },
    }),
  };
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Custody's folded body, `{ model, content, finish_reason, usage: { prompt_tokens,
 * completion_tokens, cost }, error }`, as one answer; undefined (held) for an
 * error, an error finish, no cost or a cost that is not a finite amount of at least nothing.
 */
export function readOpenRouterAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  if (shape['error'] !== null && shape['error'] !== undefined) return undefined;
  if (shape['finish_reason'] === 'error' || typeof shape['content'] !== 'string') return undefined;
  const usage = shape['usage'];
  if (typeof usage !== 'object' || usage === null) return undefined;
  const {
    prompt_tokens: input,
    completion_tokens: output,
    cost,
  } = usage as Record<string, unknown>;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined;
  if (!whole(input) || !whole(output)) return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  return {
    text: shape['content'],
    model,
    usage: { inputUnits: input, outputUnits: output },
    providerCode: null,
    reportedCost: { currency: 'USD', amount: cost },
  };
}

/**
 * A non-negative float as the exact fraction of its shortest decimal form
 * (`String(amount)`, the number as the provider wrote it): digits / 10^places.
 */
function exactDecimal(amount: number): { digits: bigint; places: number } | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(amount));
  if (match === null) return undefined;
  const fraction = match[2] ?? '';
  return {
    digits: BigInt(`${match[1] ?? '0'}${fraction}`),
    places: fraction.length - Number(match[3] ?? '0'),
  };
}

/**
 * OpenRouter's reported cost in whole AUD cents at the fixed rate, worked exactly
 * and rounded up, so any positive cost is at least a cent; NaN (held) without one
 * or past what counts in whole cents.
 */
export function openrouterCostMinor(answer: ModelAnswer): number {
  const cost = answer.reportedCost;
  if (cost?.currency !== 'USD' || !Number.isFinite(cost.amount) || cost.amount < 0)
    return Number.NaN;
  const decimal = exactDecimal(cost.amount);
  if (decimal === undefined) return Number.NaN;
  // digits / 10^places dollars × rate (millionths) × 100 cents, out of 10^6 (rate).
  const scaled = decimal.digits * millionths(OPENROUTER_AUD_PER_USD) * 100n;
  const cents =
    decimal.places >= 0
      ? ceilDiv(scaled, 10n ** BigInt(decimal.places) * 1_000_000n)
      : ceilDiv(scaled * 10n ** BigInt(-decimal.places), 1_000_000n);
  const counted = Number(cents);
  return Number.isSafeInteger(counted) ? counted : Number.NaN;
}

/** Custody's pieces are already decoded, redacted display text: passed on as they are. */
export const openrouterPieces = (): PieceReader => ({
  push: (chunk) => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return text === '' ? [] : [text];
  },
});

/** A person's question in their own conversation, answered by a paid OpenRouter model. */
export const OPENROUTER_CONVERSATION: ModelOperationDeclaration = {
  key: OPENROUTER_CONVERSATION_KEY,
  provider: OPENROUTER_PROVIDER,
  destination: 'openrouter',
  fields: CONVERSATION_ANSWER.fields,
  answer: readOpenRouterAnswer,
  timeoutMs: 120_000,
  // Raw stream bytes, counted by custody before it decodes them.
  maxResponseBytes: 512 * 1024,
  maximumMinor: Math.max(...OPENROUTER_MODELS.map((model) => openrouterHoldMinor(model))),
  settlesAt: 'completed',
  // OpenRouter's refusals before any work: a bad request, the key, the credit, a model it lacks.
  nothingHappened: ['http_400', 'http_401', 'http_402', 'http_403', 'http_404'],
  billed: true,
  concurrency: 1,
  pieces: openrouterPieces,
};
