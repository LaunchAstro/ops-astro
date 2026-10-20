// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan's answer as custody gives it back (#1620 P3).
// The Responses stream is read whole and folded to its completed response;
// the deltas never leave custody. The plan sends its stream with no
// content-type and a completed response whose output is empty, its items only
// in `response.output_item.done` events (register 284), so a missing media
// type is read as an event stream and an empty output is filled from those
// items. Only a stream whose last event is `response.completed`, with a
// `completed` response of the closed shape (`plan-shape.ts`), is answered.
// Anything
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
import { wellShaped } from './plan-shape.ts';
import { redactedValue, redacterOf } from './redaction.ts';
import { nestsTooDeep } from './json-depth.ts';

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

const field = (value: unknown, key: string): unknown => (record(value) ? value[key] : undefined);

/** An event that names the plan's usage limit: its own code, its error's, or its response's error's. */
const usageLimit = (event: Record<string, unknown>): boolean =>
  [event, field(event, 'error'), field(field(event, 'response'), 'error')].some(
    (place) => field(place, 'code') === USAGE_LIMIT,
  );

/** The done items in their places, or undefined when a place between them is missing. */
function inOrder(items: ReadonlyMap<number, unknown>): unknown[] | undefined {
  const out = Array.from({ length: items.size }, (_, at) => items.get(at));
  return out.every((item) => item !== undefined) ? out : undefined;
}

/**
 * The terminal event folded: the completed response, the allowance, or why it
 * is withheld. An empty output takes the done items, which are judged as the
 * output is.
 */
function terminal(event: Record<string, unknown>, items: ReadonlyMap<number, unknown>): Folded {
  const named = event['response'];
  if (event['type'] === 'error' || event['type'] === 'response.failed')
    return { kind: 'withheld', why: 'failed' };
  if (!record(named)) return { kind: 'withheld', why: 'malformed' };
  const empty = Array.isArray(named['output']) && named['output'].length === 0;
  const output = empty && items.size > 0 ? inOrder(items) : named['output'];
  if (output === undefined) return { kind: 'withheld', why: 'malformed' };
  const response: Record<string, unknown> = { ...named, output };
  if (nestsTooDeep(response, MOST_DEPTH)) return { kind: 'withheld', why: 'too deep' };
  if (event['type'] === 'response.incomplete' || response['status'] !== 'completed')
    return { kind: 'withheld', why: response['status'] === 'failed' ? 'failed' : 'incomplete' };
  if (!wellShaped(response)) return { kind: 'withheld', why: 'malformed' };
  return { kind: 'completed', response };
}

const TERMINAL = /^(?:error|response\.(?:completed|failed|incomplete))$/u;
const ITEM_DONE = 'response.output_item.done';

/**
 * Each event a conforming reader dispatches (one leading BOM ignored; lines
 * end in CRLF, LF or CR; a blank line dispatches), its data and its `event:`
 * name; undefined when the stream stops inside a line or an event.
 */
function eventsOf(stream: string): { data: string; name?: string }[] | undefined {
  const out: { data: string; name?: string }[] = [];
  let data: string[] = [];
  let name: string | undefined;
  // One leading BOM is not part of the stream (WHATWG, interpreting an event stream).
  const lines = stream.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
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
  const items = new Map<number, unknown>();
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
    if (event['type'] === ITEM_DONE) {
      const at = event['output_index'];
      if (
        !Number.isSafeInteger(at) ||
        Number(at) < 0 ||
        items.has(Number(at)) ||
        !record(event['item'])
      )
        return { kind: 'withheld', why: 'malformed' };
      items.set(Number(at), event['item']);
    }
    if (typeof event['type'] === 'string' && TERMINAL.test(event['type']))
      end = terminal(event, items);
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
    } else if (
      (outcome.mediaType !== undefined && outcome.mediaType !== 'text/event-stream') ||
      outcome.notUtf8 === true
    ) {
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
