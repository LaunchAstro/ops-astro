// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan's answer as custody gives it back (#1620 P3).
// The Responses stream is read whole and folded to its completed response;
// the deltas never leave custody. Only a stream whose last event is
// `response.completed`, with a `completed` response, is answered. Anything
// else is withheld, or is a named refusal: 429 or a mid-stream usage limit is
// the plan allowance, 403 a refusal of this account, 400 an unsupported
// capability, 401 signing in again, 503 the plan being unavailable. An error
// body is never read. One request is sent and none is retried.
//
// The completed response is redacted against the holder's secrets
// (`redactedValue`), so a whole echo in any spelling the redacter knows
// becomes `[redacted]`. Then the split-fragment rule: the answer is withheld
// whole when a run of FRAGMENT_RUN characters of any secret (of a signed
// token, its signature: its header and claims are not secret) appears in any
// one of its strings (each key, each value, each number's text), in that
// string percent-decoded or base64-decoded, or in a join in document order
// of all its strings, all its values, or the values under one key name. A
// secret split into strings that follow one another is caught by a join,
// however short its pieces; pieces apart or out of order are caught one by
// one. Shorter pieces apart are not judged: no text rule catches a deliberate
// encoding, and the token reaches only the request's header, never the model.

import type { Outbound } from './egress-answer.ts';
import { planRefused, type PlanCode, type PlanResult } from './plan-words.ts';
import { redactedValue, redacterOf } from './redaction.ts';

/** The shortest run of a secret that withholds an answer. */
export const FRAGMENT_RUN = 6;
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
  return { kind: 'completed', response };
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

/**
 * What a reader can join from a parsed value: every key, string and number's
 * text alone, and, in document order, all of them together, the values
 * together, and the values under each key name together (every `text`).
 */
function textsOf(value: unknown): {
  readonly alone: readonly string[];
  readonly joined: readonly string[];
} {
  const alone: string[] = [];
  const values: string[] = [];
  const byKey = new Map<string, string[]>();
  // A key's own text is filed under null: it is no value.
  const pending: [unknown, string | null][] = [[value, '']];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, key] = next;
    if (typeof item !== 'object' || item === null) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      alone.push(text);
      if (key === null) continue;
      values.push(text);
      const same = byKey.get(key) ?? [];
      same.push(text);
      byKey.set(key, same);
      continue;
    }
    const items: [unknown, string | null][] = Array.isArray(item)
      ? item.map((child) => [child, key])
      : Object.entries(item).flatMap(([name, child]) => [
          [name, null],
          [child, name],
        ]);
    // Reversed onto the list, so they come off it in document order.
    for (let at = items.length - 1; at >= 0; at -= 1) pending.push(items[at] ?? [null, null]);
  }
  const together = [alone, values, ...byKey.values()].map((texts) => texts.join(''));
  return { alone, joined: together };
}

/** Percent escapes decoded, each byte as one character. */
const unpercent = (text: string): string =>
  text.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );

/** A string as sent, percent-decoded, and base64 or base64url decoded when it is wholly that. */
function readingsOf(text: string): readonly string[] {
  const packed = text.replaceAll(/\s/gu, '').replaceAll('-', '+').replaceAll('_', '/');
  const decoded = /^[A-Za-z0-9+/]+={0,2}$/u.test(packed)
    ? [Buffer.from(packed, 'base64').toString('latin1')]
    : [];
  return [text, unpercent(text), ...decoded];
}

/** Whether a run of FRAGMENT_RUN characters of a secret (or a shorter secret whole) is in the texts. */
/** The part of a secret a fragment is judged on: a signed token's signature, or the whole. */
const secretPart = (secret: string): string =>
  /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(secret) ? secret.slice(secret.lastIndexOf('.') + 1) : secret;

function holdsFragment(texts: ReturnType<typeof textsOf>, secrets: readonly string[]): boolean {
  const runs = new Set<string>();
  for (const secret of secrets.map((whole) => secretPart(whole))) {
    const run = Math.min(FRAGMENT_RUN, secret.length);
    for (let at = 0; at + run <= secret.length; at += 1) runs.add(secret.slice(at, at + run));
  }
  const lengths = [...new Set([...runs].map((run) => run.length))];
  const readings = [...texts.alone.flatMap((text) => readingsOf(text)), ...texts.joined];
  return readings.some((text) =>
    lengths.some((length) => {
      for (let at = 0; at + length <= text.length; at += 1)
        if (runs.has(text.slice(at, at + length))) return true;
      return false;
    }),
  );
}

/** The folded answer judged against the secrets: redacted, or withheld for a fragment. */
function againstSecrets(response: Record<string, unknown>, secrets: readonly string[]): Folded {
  if (secrets.length === 0) return { kind: 'withheld', why: 'no secret to judge' };
  const redacted = redactedValue(response, redacterOf(secrets)) as Record<string, unknown>;
  if (holdsFragment(textsOf(redacted), secrets))
    return { kind: 'withheld', why: 'secret fragment' };
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
