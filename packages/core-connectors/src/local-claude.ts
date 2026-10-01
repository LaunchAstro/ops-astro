// SPDX-License-Identifier: AGPL-3.0-only
//
// The `local-claude` provider (LA-1, #859): the owner's own Claude
// subscription, through Claude Code on the owner's laptop, for local testing
// only. The broker reaches it like any destination: custody sends the request
// to the local runner (`apps/local-agent`) on loopback with the runner's own
// key, and the runner runs `claude -p` with the seat's login, which the
// product never holds or reads. The runner refuses to start unless
// `OPS_ENVIRONMENT` is `local`; the API's composition root refuses this
// provider on the same condition.
//
// The adapter half below is what runs in the broker's process. Its price is
// always nothing: the local mode spends no money. The API-equivalent cost
// Claude Code reports per call is kept in the runner's ledger, which also
// holds the cap; the runner's refusals (the cap, an unapproved model, a seat
// past its stop, a failed run) answer before any work and are positive proof
// that nothing happened, so the broker releases the call and holds nothing.

import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The provider's key in routes and operations; the setting's value is `local-claude`. */
export const LOCAL_CLAUDE_PROVIDER = 'local_claude';

/** The runner's path, fixed by LA-1's plan (`R/local-agent/PLAN.md`). */
export const LOCAL_CLAUDE_PATH = '/v1/local-claude/complete';

/** Haiku unless the owner approves another model; the runner's gate holds that. */
export const LOCAL_CLAUDE_DEFAULT_MODEL = 'haiku';

/** The runner's refusals, each answered before any work began. */
export const LOCAL_CLAUDE_NOTHING_HAPPENED: readonly string[] = [
  'LOCAL_CAP_REACHED',
  'LOCAL_MODEL_NOT_APPROVED',
  'LOCAL_SEAT_OVER_STOP',
  'LOCAL_CLAUDE_FAILED',
];

/** The adapter: fields in, a request for the default model with neither origin nor credential out. */
export function localClaudeAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  return {
    path: LOCAL_CLAUDE_PATH,
    method: 'POST',
    body: JSON.stringify({ model: LOCAL_CLAUDE_DEFAULT_MODEL, fields: values }),
  };
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The answer schema: `{ text, model, usage: { input, output }, code, costUsd }`, or nothing. */
export function readLocalClaudeAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  const { text, usage, code, costUsd } = shape;
  if (typeof text !== 'string') return undefined;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const units = usage as Record<string, unknown>;
  if (!whole(units['input']) || !whole(units['output'])) return undefined;
  if (code !== undefined && code !== null && typeof code !== 'string') return undefined;
  const priced = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0;
  if (costUsd !== undefined && !priced) return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  return {
    text,
    model,
    usage: { inputUnits: units['input'], outputUnits: units['output'] },
    providerCode: typeof code === 'string' ? code : null,
  };
}

/** The price of a local answer: nothing, whatever it would have cost on the API. */
export function localClaudeCostMinor(_answer: ModelAnswer): number {
  return 0;
}

/** A task run's step on the local session (a scheduled job, a task's agent run). */
export const LOCAL_CLAUDE_COMPOSE: ModelOperationDeclaration = {
  key: 'model.local_claude_compose',
  provider: LOCAL_CLAUDE_PROVIDER,
  destination: 'local_claude',
  fields: { instruction: 'free_text', tone: 'business_internal' },
  answer: readLocalClaudeAnswer,
  // A headless Claude Code call takes seconds, sometimes a minute or two.
  timeoutMs: 120_000,
  maxResponseBytes: 256 * 1024,
  maximumMinor: 100,
  settlesAt: 'completed',
  nothingHappened: LOCAL_CLAUDE_NOTHING_HAPPENED,
  billed: true,
  concurrency: 2,
};

/**
 * A person's question in their own conversation, answered by the local
 * session. It carries the conversation operation's key, so the conversation
 * seam, which asks for that one key, reaches it where the composition root
 * catalogues it in the replay declaration's place.
 */
export const LOCAL_CLAUDE_CONVERSATION: ModelOperationDeclaration = {
  ...LOCAL_CLAUDE_COMPOSE,
  key: CONVERSATION_ANSWER.key,
  fields: CONVERSATION_ANSWER.fields,
};
