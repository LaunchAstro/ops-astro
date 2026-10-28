// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's change requests as the review's task dock draws them (#2119, spec #2085): what each
// request is now, read from `review.read`'s `changeRequests`, and the client pins a person may
// still file. An approved request with no task is pending: a worker makes it a task under its
// lease (#2117), so it is never drawn as done until `createdTaskId` names the task.
//
// An agent's filing of a client's pin is a model reading the client's words. Until a local
// model exists the server refuses it CLIENT_MODEL_USE_OFF (`review-change.ts`), and a broker
// offered a subscription provider refuses SUBSCRIPTION_NOT_FOR_CLIENT_WORK (`carry-rule.ts`):
// both read as the one wait here, and a person files the pin with their own words meanwhile.

import type { ReviewReadResult } from '../../../../../packages/core-wire/src/index.ts';

export type ChangeRequestView = ReviewReadResult['review']['changeRequests'][number];
export type PinView = ReviewReadResult['review']['pins'][number];

/** What the panel has read: nothing yet, the server's refusal, or the review's requests and pins. */
export type DockLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused'; readonly because: string }
  | {
      readonly kind: 'ready';
      readonly requests: readonly ChangeRequestView[];
      readonly pins: readonly PinView[];
    };

/** Where a request stands: `pending` is approved with its task not made yet. */
export type RequestPhase = 'proposed' | 'pending' | 'made' | 'refused';

export function phaseOf(request: ChangeRequestView): RequestPhase {
  if (request.state === 'proposed') return 'proposed';
  if (request.state === 'refused') return 'refused';
  return request.createdTaskId === null ? 'pending' : 'made';
}

export const PHASE_LABEL: Readonly<Record<RequestPhase, string>> = {
  proposed: 'Proposed',
  pending: 'Approved, task not made yet',
  made: 'Approved and made a task',
  refused: 'Refused',
};

export const PHASE_TONE = {
  proposed: 'info',
  pending: 'warn',
  made: 'ok',
  refused: 'idle',
} as const satisfies Readonly<Record<RequestPhase, string>>;

/** The two refusals that mean the agent's filing waits on a local model. */
export const LOCAL_MODEL_CODES = [
  'CLIENT_MODEL_USE_OFF',
  'SUBSCRIPTION_NOT_FOR_CLIENT_WORK',
] as const;
export type LocalModelCode = (typeof LOCAL_MODEL_CODES)[number];

export const waitsOnLocalModel = (code: string): code is LocalModelCode =>
  (LOCAL_MODEL_CODES as readonly string[]).includes(code);

export const AGENT_WAIT =
  'An agent’s filing waits on a local model: reading a client’s pin would send their words to a model. File it yourself meanwhile.';

/** The client pins with no change request yet, oldest first, as the read lists them. */
export function unfiledClientPins(
  pins: readonly PinView[],
  requests: readonly ChangeRequestView[],
): readonly PinView[] {
  const filed = new Set(requests.map((request) => request.commentId));
  return pins.filter((pin) => pin.audience === 'client' && !filed.has(pin.commentId));
}
