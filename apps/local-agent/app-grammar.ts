// SPDX-License-Identifier: AGPL-3.0-only
//
// The grammar of a streamed call's turn (codex-app.ts): what each message from
// `codex app-server` means. It is closed, as exec's events are (codex.ts). The
// user's message, the agent's message and its reasoning are the only items a
// chat turn may hold; the user's message is the call's own input echoed, so it
// is never a piece and never proof the model gave anything back. Only the
// first agent message's pieces are passed on; the reasoning's never are. Any
// other item, and any notification this file does not know, refuses the turn.

import { UNKNOWN, USAGE_LIMIT, type CodexResult } from './codex.ts';
import type { Refused } from './gate.ts';

/** Notifications that carry no model output and change nothing: read and let pass. */
const QUIET: ReadonlySet<string> = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/settings/updated',
  'turn/started',
  'account/updated',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'serverRequest/resolved',
  'warning',
  'configWarning',
  'deprecationNotice',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
]);

/** The items a chat turn may hold; any other is a tool or an action. */
const ITEMS: ReadonlySet<string> = new Set(['userMessage', 'agentMessage', 'reasoning']);

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export interface Turn {
  /** The first agent message's id: only its pieces are passed on. */
  streaming: string | undefined;
  /** A second agent message began: no more pieces for this call. */
  piecesStopped: boolean;
  text: string | undefined;
  usage: { readonly input: number; readonly output: number } | undefined;
  failed: boolean;
  limited: boolean;
  /** The plan refused the turn's sign-in. */
  unauthorized: boolean;
  /** The model gave something back (any item but the user's own message). */
  started: boolean;
}

/** A turn before any message of it is read. */
export const freshTurn = (): Turn => ({
  streaming: undefined,
  piecesStopped: false,
  text: undefined,
  usage: undefined,
  failed: false,
  limited: false,
  unauthorized: false,
  started: false,
});

/** A failure's own words and code: a plan at its limit is the owner's stop, not a fault. */
function failure(turn: Turn, error: Record<string, unknown> | undefined): void {
  turn.failed = true;
  if (error?.['codexErrorInfo'] === 'unauthorized') turn.unauthorized = true;
  const message = error?.['message'];
  if (
    error?.['codexErrorInfo'] === 'usageLimitExceeded' ||
    (typeof message === 'string' && USAGE_LIMIT.test(message))
  ) {
    turn.limited = true;
  }
}

/**
 * The turn's result once it completed, or unknown when its tokens were never
 * reported. A turn refused its sign-in before the model gave anything asked
 * nothing of it: signed out, never charged.
 */
export function resultOf(turn: Turn, model: string): CodexResult | typeof UNKNOWN | Refused {
  if (turn.unauthorized && !turn.started && turn.usage === undefined) {
    return { refused: 'GPT_SIGNED_OUT' };
  }
  if (turn.usage === undefined) {
    // A plan at its limit before the model gave anything used nothing; otherwise what it used is unknown.
    return turn.limited && !turn.started
      ? { text: '', model, inputTokens: 0, outputTokens: 0, failed: true, limited: true }
      : UNKNOWN;
  }
  const failed = turn.failed || turn.text === undefined;
  return {
    text: failed ? '' : (turn.text ?? ''),
    model,
    inputTokens: turn.usage.input,
    outputTokens: turn.usage.output,
    failed,
    limited: turn.limited,
  };
}

/** An item's start or end; false when the item is one a chat turn never holds. */
function readItem(method: string, params: Record<string, unknown>, turn: Turn): boolean {
  const item = record(params['item']);
  const kind = item?.['type'];
  const id = item?.['id'];
  if (typeof kind !== 'string' || typeof id !== 'string' || !ITEMS.has(kind)) return false;
  if (kind !== 'userMessage') turn.started = true;
  if (kind !== 'agentMessage') return true;
  if (method === 'item/started') {
    if (turn.streaming === undefined) turn.streaming = id;
    else if (turn.streaming !== id) turn.piecesStopped = true;
  } else {
    const text = item?.['text'];
    if (typeof text !== 'string') return false;
    turn.text = text;
  }
  return true;
}

type Reading = 'continue' | 'completed' | 'refused';

/** One notification into the turn: on, the turn's end, or a message this grammar refuses. */
export function readNotification(
  method: string,
  params: Record<string, unknown>,
  turn: Turn,
  onDelta: (text: string) => void,
): Reading {
  if (QUIET.has(method)) return 'continue';
  if (method === 'item/started' || method === 'item/completed') {
    return readItem(method, params, turn) ? 'continue' : 'refused';
  }
  if (method === 'item/agentMessage/delta') {
    const delta = params['delta'];
    if (typeof delta !== 'string') return 'refused';
    if (!turn.piecesStopped && params['itemId'] === turn.streaming && delta !== '') onDelta(delta);
    return 'continue';
  }
  if (method === 'thread/tokenUsage/updated') {
    const last = record(record(params['tokenUsage'])?.['last']);
    const input = count(last?.['inputTokens']);
    const output = count(last?.['outputTokens']);
    if (input === undefined || output === undefined) return 'refused';
    turn.usage = { input, output };
    return 'continue';
  }
  if (method === 'error') {
    // An error the server retries itself is not the turn's end.
    if (params['willRetry'] !== true) failure(turn, record(params['error']));
    return 'continue';
  }
  if (method === 'turn/completed') {
    const ended = record(params['turn']);
    const status = ended?.['status'];
    if (status !== 'completed') failure(turn, record(ended?.['error']));
    return 'completed';
  }
  return 'refused';
}
