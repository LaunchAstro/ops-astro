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
// whole when a run of FRAGMENT_RUN characters of any secret appears in any
// one of its strings (each key, each value, each number's text), in that
// string percent-decoded or base64-decoded, or in a join in document order
// of all its strings, or of the values under one key name (every `text`).
// A secret split in order is caught by a join, however short its pieces;
// pieces in another order are caught one by one. Shorter pieces out of order
// are not judged: no text rule catches a deliberate encoding, and the token
// reaches only the request's header, never the model. No network code here.

import type { Outbound } from './egress-answer.ts';
import type { PlanRefusal } from './plan-token.ts';
import { redactedValue, redacterOf } from './redaction.ts';

/** The shortest run of a secret that withholds an answer. */
export const FRAGMENT_RUN = 6;
/** The deepest nesting a completed response may have; a Responses answer is a few levels deep. */
const MOST_DEPTH = 64;
const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';

export type PlanCode =
  | PlanRefusal
  | 'SUBSCRIPTION_PLAN_ALLOWANCE'
  | 'SUBSCRIPTION_NOT_ELIGIBLE'
  | 'SUBSCRIPTION_UNSUPPORTED_CAPABILITY'
  | 'SUBSCRIPTION_PLAN_UNAVAILABLE'
  | 'SUBSCRIPTION_ANSWER_WITHHELD';
export type PlanResult =
  | { readonly ok: true; readonly response: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: PlanCode; readonly words: string };
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

/** Words a task can show for each named result. */
export const PLAN_WORDS: Readonly<Record<PlanCode, string>> = {
  SUBSCRIPTION_SIGN_IN_NEEDED:
    'The ChatGPT plan on the M5 needs the owner to sign in again. Nothing more is sent until then.',
  SUBSCRIPTION_REFRESH_FAILED:
    'The ChatGPT plan’s sign-in could not be renewed in time. Nothing was sent; restart the task.',
  SUBSCRIPTION_STORE_FAILED:
    'Custody could not keep the ChatGPT plan’s sign-in safely on the M5. Nothing was sent.',
  SUBSCRIPTION_TOKEN_FILE_OPEN:
    'The ChatGPT plan’s token file on the M5 is open to other users, so custody will not use it. Nothing was sent.',
  SUBSCRIPTION_PLAN_ALLOWANCE:
    'The ChatGPT plan has reached its usage allowance. Nothing was retried; restart the task once it resets.',
  SUBSCRIPTION_NOT_ELIGIBLE:
    'The ChatGPT plan refused this account or workspace. Nothing was retried.',
  SUBSCRIPTION_UNSUPPORTED_CAPABILITY:
    'The ChatGPT plan does not support what this call asked for. Nothing was retried.',
  SUBSCRIPTION_PLAN_UNAVAILABLE:
    'The ChatGPT plan is unavailable just now. Nothing was retried; the owner can restart the task.',
  SUBSCRIPTION_ANSWER_WITHHELD:
    'The ChatGPT plan’s answer did not finish cleanly, so custody withheld it. Nothing was retried.',
};

/** A holder's refusal from `prepare()`, as the caller is told it. */
export const planRefused = (code: PlanCode): PlanResult => ({
  ok: false,
  code,
  words: PLAN_WORDS[code],
});

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

/** A failed response or error event that names the plan's usage limit. */
const usageLimit = (event: Record<string, unknown>): boolean => {
  const response = record(event['response']) ? event['response'] : {};
  const error = record(response['error']) ? response['error'] : {};
  return event['code'] === USAGE_LIMIT || error['code'] === USAGE_LIMIT;
};

/** The terminal event folded: the completed response, the allowance, or why it is withheld. */
function terminal(event: Record<string, unknown>): Folded {
  if (usageLimit(event)) return { kind: 'allowance' };
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

/** A whole Responses stream folded: its last event must be the one terminal event. */
function folded(stream: string): Folded {
  let end: Folded | undefined;
  for (const block of stream.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u).filter((line) => line.startsWith('data:'));
    if (lines.length === 0) continue;
    // Nothing may follow the terminal event.
    if (end !== undefined) return { kind: 'withheld', why: 'malformed' };
    let event: unknown;
    try {
      event = JSON.parse(lines.map((line) => line.slice(5).replace(/^ /u, '')).join('\n'));
    } catch {
      return { kind: 'withheld', why: 'malformed' };
    }
    if (!record(event)) return { kind: 'withheld', why: 'malformed' };
    if (typeof event['type'] === 'string' && TERMINAL.test(event['type'])) end = terminal(event);
  }
  return end ?? { kind: 'withheld', why: 'interrupted' };
}

/**
 * What a reader can join from a parsed value: every key, string and number's
 * text alone, and, in document order, all of them together and the values
 * under each key name together (every `text`, every `arguments`).
 */
function textsOf(value: unknown): {
  readonly alone: readonly string[];
  readonly joined: readonly string[];
} {
  const alone: string[] = [];
  const byKey = new Map<string, string[]>();
  const pending: [unknown, string][] = [[value, '']];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, key] = next;
    if (typeof item !== 'object' || item === null) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      alone.push(text);
      const same = byKey.get(key) ?? [];
      same.push(text);
      byKey.set(key, same);
      continue;
    }
    const items: [unknown, string][] = Array.isArray(item)
      ? item.map((child) => [child, key])
      : Object.entries(item).flatMap(([name, child]) => [
          [name, ''],
          [child, name],
        ]);
    // Reversed onto the list, so they come off it in document order.
    for (let at = items.length - 1; at >= 0; at -= 1) pending.push(items[at] ?? [null, '']);
  }
  return { alone, joined: [alone.join(''), ...[...byKey.values()].map((texts) => texts.join(''))] };
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
function holdsFragment(texts: ReturnType<typeof textsOf>, secrets: readonly string[]): boolean {
  const runs = new Set<string>();
  for (const secret of secrets) {
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
      const refused =
        outcome.fault === 'status' ? REFUSED_STATUS.get(outcome.status ?? 0) : undefined;
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
