// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan's answer as custody gives it back (#1620 P3).
// The Responses stream is read whole and folded to its completed response;
// the deltas never leave custody. Only a stream whose last event is
// `response.completed`, with a `completed` response whose id, model, output
// items and usage counts have their shape (`wellShaped`), is answered. Anything
// else is withheld, or is a named refusal: 429 or a mid-stream usage limit is
// the plan allowance, 403 a refusal of this account, 400 an unsupported
// capability, 401 signing in again, 503 the plan being unavailable. An error
// body is never read. One request is sent and none is retried.
//
// The completed response is redacted against the holder's secrets
// (`redactedValue`), so a whole echo in any spelling the redacter knows
// becomes `[redacted]`. What redaction leaves is judged by the split-fragment
// rules (`plan-fragments.ts`): a run of a secret, or pieces of one in any
// order, withhold the answer whole.

import type { Outbound } from './egress-answer.ts';
import { planRefused, type PlanCode, type PlanResult } from './plan-words.ts';
import { holdsSecret } from './plan-fragments.ts';
import { redactedValue, redacterOf } from './redaction.ts';

export { FRAGMENT_RUN } from './plan-fragments.ts';

/** The deepest nesting a completed response may have; a Responses answer is a few levels deep. */
const MOST_DEPTH = 64;
const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';

export type PlanAnswerLog =
  | 'plan answer completed'
  | 'plan answer withheld: malformed'
  | 'plan answer withheld: interrupted'
  | 'plan answer withheld: incomplete'
  | 'plan answer withheld: failed'
  | 'plan answer withheld: too deep'
  | 'plan answer withheld: secret fragment'
  | 'plan answer withheld: no secret to judge'
  | 'plan refused: usage allowance'
  | 'plan refused: not eligible'
  | 'plan refused: unsupported capability'
  | 'plan refused: sign in again'
  | 'plan refused: unavailable';
type Log = (kind: PlanAnswerLog) => void;

const REFUSED_STATUS: ReadonlyMap<number, readonly [PlanCode, PlanAnswerLog]> = new Map([
  [429, ['SUBSCRIPTION_PLAN_ALLOWANCE', 'plan refused: usage allowance']],
  [403, ['SUBSCRIPTION_NOT_ELIGIBLE', 'plan refused: not eligible']],
  [400, ['SUBSCRIPTION_UNSUPPORTED_CAPABILITY', 'plan refused: unsupported capability']],
  [401, ['SUBSCRIPTION_SIGN_IN_NEEDED', 'plan refused: sign in again']],
  [503, ['SUBSCRIPTION_PLAN_UNAVAILABLE', 'plan refused: unavailable']],
]);

/** Why an answer is withheld, as its log line names it. */
type Withheld = PlanAnswerLog extends infer K
  ? K extends `plan answer withheld: ${infer W}`
    ? W
    : never
  : never;
type Folded =
  | { readonly kind: 'completed'; readonly response: Record<string, unknown> }
  | { readonly kind: 'allowance' }
  | { readonly kind: 'withheld'; readonly why: Withheld };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a parsed value nests deeper than MOST_DEPTH, judged from its own list, not the call stack. */
function tooDeep(value: unknown): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, depth] = next;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= MOST_DEPTH) return true;
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return false;
}

const field = (value: unknown, key: string): unknown => (record(value) ? value[key] : undefined);

/** An event that names the plan's usage limit: its own code, its error's, or its response's error's. */
const usageLimit = (event: Record<string, unknown>): boolean =>
  [event, field(event, 'error'), field(field(event, 'response'), 'error')].some(
    (place) => field(place, 'code') === USAGE_LIMIT,
  );

/** The terminal event folded: the completed response, the allowance, or why it is withheld. */
function terminal(event: Record<string, unknown>): Folded {
  const response = event['response'];
  if (event['type'] === 'error' || event['type'] === 'response.failed')
    return { kind: 'withheld', why: 'failed' };
  if (!record(response)) return { kind: 'withheld', why: 'malformed' };
  if (tooDeep(response)) return { kind: 'withheld', why: 'too deep' };
  if (event['type'] === 'response.incomplete' || response['status'] !== 'completed')
    return { kind: 'withheld', why: response['status'] === 'failed' ? 'failed' : 'incomplete' };
  if (!wellShaped(response)) return { kind: 'withheld', why: 'malformed' };
  return { kind: 'completed', response };
}

const text = (value: unknown): value is string => typeof value === 'string';
const USAGE_COUNTS = ['input_tokens', 'output_tokens', 'total_tokens'] as const;

/** An output item a reader can index: typed, a message's parts typed with their texts, a call's names and arguments. */
function itemShaped(item: unknown): boolean {
  if (!record(item) || !text(item['type'])) return false;
  if (item['type'] === 'message') {
    const content = item['content'];
    return (
      Array.isArray(content) &&
      content.every(
        (part) =>
          record(part) &&
          text(part['type']) &&
          (part['type'] !== 'output_text' || text(part['text'])),
      )
    );
  }
  if (item['type'] === 'function_call')
    return (
      text(item['name']) &&
      text(item['arguments']) &&
      (item['call_id'] === undefined || text(item['call_id']))
    );
  return true;
}

/** Whether a completed response has the shape a reader indexes: its id, model, output items and usage counts. */
function wellShaped(response: Record<string, unknown>): boolean {
  const { id, model, output, usage } = response;
  return (
    text(id) &&
    text(model) &&
    Array.isArray(output) &&
    output.every((item) => itemShaped(item)) &&
    (usage === undefined ||
      (record(usage) &&
        USAGE_COUNTS.every((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)))
  );
}

const TERMINAL = /^(?:error|response\.(?:completed|failed|incomplete))$/u;

/**
 * Each event a conforming reader dispatches (lines end in CRLF, LF or CR; a
 * blank line dispatches), its data and its `event:` name; undefined when the
 * stream stops inside a line or an event.
 */
function eventsOf(stream: string): { data: string; name?: string }[] | undefined {
  const out: { data: string; name?: string }[] = [];
  let data: string[] = [];
  let name: string | undefined;
  const lines = stream.split(/\r\n|\r|\n/u);
  if (lines.pop() !== '') return undefined;
  for (const line of lines) {
    if (line === '') {
      if (data.length > 0)
        out.push({ data: data.join('\n'), ...(name === undefined ? {} : { name }) });
      [data, name] = [[], undefined];
      continue;
    }
    const colon = line.includes(':') ? line.indexOf(':') : line.length;
    const value = line.slice(colon + 1).replace(/^ /u, '');
    if (line.slice(0, colon) === 'data') data.push(value);
    else if (line.slice(0, colon) === 'event') name = value;
  }
  return data.length > 0 ? undefined : out;
}

/** A whole Responses stream folded: its last event must be the one terminal event. */
function folded(stream: string): Folded {
  const events = eventsOf(stream);
  if (events === undefined) return { kind: 'withheld', why: 'interrupted' };
  let end: Folded | undefined;
  for (const { data, name } of events) {
    // Nothing may follow the terminal event.
    if (end !== undefined) return { kind: 'withheld', why: 'malformed' };
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return { kind: 'withheld', why: 'malformed' };
    }
    if (!record(event) || (name !== undefined && name !== event['type']))
      return { kind: 'withheld', why: 'malformed' };
    if (usageLimit(event)) return { kind: 'allowance' };
    if (typeof event['type'] === 'string' && TERMINAL.test(event['type'])) end = terminal(event);
  }
  return end ?? { kind: 'withheld', why: 'interrupted' };
}

/** The folded answer judged against the secrets: redacted, or withheld for a fragment. */
function againstSecrets(response: Record<string, unknown>, secrets: readonly string[]): Folded {
  if (secrets.length === 0) return { kind: 'withheld', why: 'no secret to judge' };
  const redacted = redactedValue(response, redacterOf(secrets)) as Record<string, unknown>;
  if (holdsSecret(redacted, secrets)) return { kind: 'withheld', why: 'secret fragment' };
  // Redaction turns a count that spells a secret into text; the answer keeps its shape or is withheld.
  if (!wellShaped(redacted)) return { kind: 'withheld', why: 'secret fragment' };
  return { kind: 'completed', response: redacted };
}

/** What egress answered, as a named result. Never throws: whatever the answer held, custody serves on. */
export function planAnswer(
  outcome: Outbound,
  secrets: readonly string[],
  log: Log = () => {},
): PlanResult {
  let out: Folded;
  try {
    if (!outcome.ok) {
      const refused = REFUSED_STATUS.get(outcome.status ?? 0);
      if (refused !== undefined) {
        log(refused[1]);
        return planRefused(refused[0]);
      }
      const lost = outcome.fault === 'timeout' || outcome.fault === 'network';
      out = { kind: 'withheld', why: lost ? 'interrupted' : 'failed' };
    } else if (outcome.mediaType !== 'text/event-stream' || outcome.notUtf8 === true) {
      out = { kind: 'withheld', why: 'malformed' };
    } else {
      out = folded(outcome.body);
      if (out.kind === 'completed') out = againstSecrets(out.response, secrets);
    }
  } catch {
    out = { kind: 'withheld', why: 'malformed' };
  }
  if (out.kind === 'completed') {
    log('plan answer completed');
    return { ok: true, response: out.response };
  }
  if (out.kind === 'allowance') {
    log('plan refused: usage allowance');
    return planRefused('SUBSCRIPTION_PLAN_ALLOWANCE');
  }
  log(`plan answer withheld: ${out.why}`);
  return planRefused('SUBSCRIPTION_ANSWER_WITHHELD');
}

/**
 * One request to the plan, judged. `send` is called exactly once, and a
 * throw is an interrupted answer, never a retry. The secrets are read after
 * the answer, so a token the holder took on meanwhile is judged too.
 */
export async function askPlanOnce(
  send: () => Promise<Outbound>,
  secrets: () => readonly string[],
  log?: Log,
): Promise<PlanResult> {
  let outcome: Outbound;
  try {
    outcome = await send();
  } catch {
    outcome = { ok: false, fault: 'network', status: null };
  }
  return planAnswer(outcome, secrets(), log);
}
