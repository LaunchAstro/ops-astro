// SPDX-License-Identifier: AGPL-3.0-only
//
// The `local-gpt` provider (LA-1, #859; owner 7 October 2026: GPT, not
// Claude): the owner's own ChatGPT plan, through `codex exec` on the owner's
// laptop, for local testing only. The broker reaches it like any destination:
// custody sends the request to the local runner (`apps/local-agent`) on
// loopback with the runner's own key, and the runner runs `codex exec` with
// its own Codex login, which the product never holds or reads. The runner
// refuses to start unless `OPS_ENVIRONMENT` is `local`; the API's composition
// root refuses this provider on the same condition.
//
// The adapter half below is what runs in the broker's process. Its price is
// always nothing: the plan is paid for already and the local mode spends no
// money. The tokens a call used are kept in the runner's ledger, which also
// holds the cap; the runner's refusals (the cap, an unapproved model, the
// plan at its usage limit, a failed run) answer before any work, or after a run whose answer is not used, and
// are positive proof that nothing was kept, so the broker releases the call
// and holds nothing.

import {
  readModelId,
  type AdapterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from './operation.ts';
import { CONVERSATION_ANSWER } from './replay.ts';

/** The provider's key in routes and operations; the setting's value is `local-gpt`. */
export const LOCAL_GPT_PROVIDER = 'local_gpt';

/** The runner's one path. */
export const LOCAL_GPT_PATH = '/v1/local-gpt/complete';

/** The model Codex runs on the owner's laptop, unless the owner approves another; the runner's gate holds that. */
export const LOCAL_GPT_DEFAULT_MODEL = 'gpt-6.1-sol';

/** The runner's refusals, each answered with nothing kept. */
export const LOCAL_GPT_NOTHING_HAPPENED: readonly string[] = [
  'LOCAL_CAP_REACHED',
  'LOCAL_MODEL_NOT_APPROVED',
  'LOCAL_PLAN_LIMIT',
  'LOCAL_GPT_FAILED',
  // The runner's door refuses these before any work: a wrong key, path or method, a bad body.
  'http_400',
  'http_401',
  'http_404',
  'http_405',
  'http_413',
];

/** The adapter: fields in, a request for the default model with neither origin nor credential out. */
export function localGptAdapter(values: Readonly<Record<string, string>>): AdapterRequest {
  return {
    path: LOCAL_GPT_PATH,
    method: 'POST',
    body: JSON.stringify({ model: LOCAL_GPT_DEFAULT_MODEL, fields: values }),
  };
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The answer schema: `{ text, model, usage: { input, output }, code }`, or nothing. */
export function readLocalGptAnswer(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const shape = body as Record<string, unknown>;
  const { text, usage, code } = shape;
  if (typeof text !== 'string') return undefined;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const units = usage as Record<string, unknown>;
  if (!whole(units['input']) || !whole(units['output'])) return undefined;
  if (code !== undefined && code !== null && typeof code !== 'string') return undefined;
  const model = readModelId(shape['model']);
  if (model === undefined) return undefined;
  return {
    text,
    model,
    usage: { inputUnits: units['input'], outputUnits: units['output'] },
    providerCode: typeof code === 'string' ? code : null,
  };
}

/** The price of a local answer: nothing, whatever the call used. */
export function localGptCostMinor(_answer: ModelAnswer): number {
  return 0;
}

/**
 * A task run's step on the local session (a scheduled job, a task's agent
 * run). GPT is a cloud model, so its route is declared `cloud`, and the
 * step's task text is free text, which goes to no cloud route: on the GPT
 * route this step waits on a local model (`LOCAL_MODEL_REQUIRED`), as owner
 * line 72 asks. Only the conversation below reaches GPT.
 */
export const LOCAL_GPT_COMPOSE: ModelOperationDeclaration = {
  key: 'model.local_gpt_compose',
  provider: LOCAL_GPT_PROVIDER,
  destination: 'local_gpt',
  fields: { instruction: 'free_text', tone: 'business_internal' },
  answer: readLocalGptAnswer,
  // A `codex exec` call takes seconds, sometimes a minute or two.
  timeoutMs: 120_000,
  maxResponseBytes: 256 * 1024,
  maximumMinor: 100,
  settlesAt: 'completed',
  nothingHappened: LOCAL_GPT_NOTHING_HAPPENED,
  billed: true,
  concurrency: 2,
};

/**
 * A person's question in their own conversation, answered by the local
 * session. It carries the conversation operation's key, so the conversation
 * seam, which asks for that one key, reaches it where the composition root
 * catalogues it in the replay declaration's place. The seam takes this cloud
 * route only under LA-1's laptop carve-out, for the owner's own typed message
 * (broker-conversation.ts).
 */
export const LOCAL_GPT_CONVERSATION: ModelOperationDeclaration = {
  ...LOCAL_GPT_COMPOSE,
  key: CONVERSATION_ANSWER.key,
  fields: CONVERSATION_ANSWER.fields,
};
