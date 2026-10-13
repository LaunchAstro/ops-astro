// SPDX-License-Identifier: AGPL-3.0-only
//
// The carried custody (live chat route B): the custody a hosted function's
// broker sends through when its model runs on the owner's machine. It holds
// no provider credential and no destination; it holds the carry key and joins
// the call's line with the person's own token.
//
// One call, given its handoff from the command layer (`Handoff`):
//
// 1. Join `carry:<business>:call:<call>`. Refused: nothing offered.
// 2. The offer judgement (`handoff.offer`); passing, the database rings the
//    agent's doorbell. Refused: nothing offered.
// 3. The first sealed accept within the accept window, or the call is
//    released: only a request sends, and none was sent.
// 4. The send judgement (`handoff.fence`), whose transaction holds every lock
//    the call's authority rests on until the request is written or can no
//    longer be: `written`, a sealed refusal, or W after the accept was heard.
// 5. The sealed request, deadline the accept plus W on the agent's own clock.
// 6. Pieces in order, until the first gap; `working` while the model loads;
//    then the sealed answer, custody's own outcome.
//
// After the request, anything short of a sealed answer or refusal is unknown:
// the call is held (`worker_lost`, started). Its settlement goes through
// `fenceIn`, under the call's lock: the call still dispatched, the runner the
// one the send recorded, before its `answer_by`.

import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  ACCEPT_WINDOW_MS,
  callTopic,
  deadlineOf,
  SEAL_LIFE_MS,
  SEND_WINDOW_MS,
  SILENCE_MS,
  STARTED_GRACE_MS,
  type CarriedOutcome,
  type Carriage,
  type Handoff,
  type Line,
} from './carriage.ts';
import { sealed, type CarryKeys } from './carry-seal.ts';
import { listen, type Heard, type Next, type Skew } from './carried-line.ts';
import type { Custody, CustodyOutcome } from './custody.ts';
import type { OutboundRequest } from './egress.ts';

export interface CarriedCustodyOptions {
  readonly carriage: Carriage;
  readonly keys: CarryKeys;
  /** The current key, which this side seals with. */
  readonly key: string;
  readonly now?: () => number;
}

/** What each step of a call needs: the options, the clock, and the runner each call was sent to. */
interface Carrying {
  readonly options: CarriedCustodyOptions;
  readonly now: () => number;
  readonly runners: Map<string, string>;
}

const refused = (code: string): CustodyOutcome => ({ kind: 'refused', started: false, code });
const lost: CustodyOutcome = { kind: 'worker_lost', started: true, fault: 'ours' };
const nothing = (): void => {};

/** The call and the runner a broker message is for. */
interface Called {
  readonly k: string;
  readonly runner: string;
}

const codeOf = (body: unknown): string => String((body as { code?: unknown } | null)?.code);

/** The agent's answer as the broker reads a custody's: answered whole, or refused. */
function outcomeOf(body: unknown): CustodyOutcome {
  const answer = body as CarriedOutcome;
  if (answer?.kind === 'refused' && typeof answer.code === 'string') return refused(answer.code);
  if (answer?.kind !== 'answered' || typeof answer.outbound !== 'object') return lost;
  const { outbound } = answer;
  return { kind: 'answered', started: true, outbound, credentialKind: 'api_key', account: null };
}

/** A broker message for call `k`, sealed to expire one seal's life out on the agent's clock. */
function sealOf(carrying: Carrying, skew: Skew, call: Called, event: string, body: unknown) {
  const { k, runner } = call;
  return sealed(carrying.options.key, {
    direction: 'broker',
    k,
    runner,
    event,
    seq: 0,
    expiresAt: carrying.now() + (skew.at ?? 0) + SEAL_LIFE_MS,
    body: JSON.stringify(body),
  });
}

/** After the request: pieces in order to the first gap, then the answer; silence is held. */
async function follow(
  carrying: Carrying,
  next: Next,
  runner: string,
  onPiece: ((text: string) => void) | undefined,
): Promise<CustodyOutcome> {
  let expected = 0;
  let broken = false;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one message after another
    const heard = await next((each) => each.runner === runner, carrying.now() + SILENCE_MS);
    if (heard === undefined) return lost;
    if (heard.event === 'answer') return outcomeOf(heard.body);
    if (heard.event === 'refused') return refused(codeOf(heard.body));
    if (heard.event === 'piece' && !broken) {
      broken = heard.seq !== expected;
      expected += 1;
      const { text } = heard.body as { text?: unknown };
      if (!broken && typeof text === 'string') onPiece?.(text);
    }
  }
}

/**
 * The request sent, and the send judgement's locks held until the write is
 * reported or refused, or W after the accept was heard; then whether the call
 * goes on (undefined) or how it ended.
 */
async function send(
  carrying: Carrying,
  line: Line,
  next: Next,
  sending: Called & { readonly heardAt: number; readonly skew: Skew },
  request: Record<string, unknown>,
): Promise<CustodyOutcome | undefined> {
  const { runner, heardAt } = sending;
  await line.send('request', sealOf(carrying, sending.skew, sending, 'request', request));
  const done = (heard: Heard): boolean =>
    heard.runner === runner && (heard.event === 'written' || heard.event === 'refused');
  const written = await next(done, heardAt + SEND_WINDOW_MS);
  if (written?.event === 'refused') return refused(codeOf(written.body));
  if (written !== undefined) return undefined;
  // Past W a late request is still refused, sealed: nothing was written.
  const started = await next(
    (heard) => heard.runner === runner && (heard.event === 'started' || heard.event === 'refused'),
    heardAt + SEND_WINDOW_MS + STARTED_GRACE_MS,
  );
  if (started?.event === 'refused') return refused(codeOf(started.body));
  return started === undefined ? lost : undefined;
}

/** One call on its joined line: offer, accept, the fenced send, then its answer. */
async function carry(
  carrying: Carrying,
  line: Line,
  asked: { readonly request: OutboundRequest; readonly onPiece?: (text: string) => void },
  handoff: Handoff,
): Promise<CustodyOutcome> {
  const k = handoff.callId;
  const skew: Skew = { at: undefined };
  const next = listen(line, carrying.options.keys, k, { now: carrying.now, skew });
  const offeredAt = carrying.now();
  const offer = await handoff.offer();
  if (!offer.ok) return refused(offer.code);
  const accept = await next((heard) => heard.event === 'accept', carrying.now() + ACCEPT_WINDOW_MS);
  const heardAt = carrying.now();
  const acceptedAt = Number((accept?.body as { acceptedAt?: unknown } | null)?.acceptedAt);
  if (accept === undefined || !Number.isSafeInteger(acceptedAt))
    return refused('MODEL_MACHINE_AWAY');
  const { runner } = accept;
  // The agent stamped its accept after the offer, so its clock is at most this far ahead:
  // every later seal, both ways, is judged on that, and an expired one is never live.
  skew.at = acceptedAt - offeredAt;
  const fence = await handoff.fence({ runner, acceptedAt, heardAt });
  if (!fence.ok) return refused(fence.code);
  carrying.runners.set(k, runner);
  const request = { request: asked.request, deadlineAt: deadlineOf(acceptedAt) };
  let ending: CustodyOutcome | undefined;
  try {
    ending = await send(carrying, line, next, { k, runner, heardAt, skew }, request);
  } finally {
    await fence.release();
  }
  if (ending !== undefined) return ending;
  const outcome = await follow(carrying, next, runner, asked.onPiece);
  if (outcome.kind !== 'worker_lost')
    await line.send('settled', sealOf(carrying, skew, { k, runner }, 'settled', {}));
  return outcome;
}

/** The settlement fence: the call still dispatched, the runner sent to, before its `answer_by`. */
async function fenced(tx: TenantQuery, callId: string, runner: string): Promise<boolean> {
  const [row] = await tx.query<{ readonly ok: boolean }>(
    `select c.state = 'dispatched' and k.runner = $3::uuid and k.answer_by > clock_timestamp() as ok
       from public.model_calls c
       join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      where c.business_id = $1 and c.id = $2
      for update of c for share of k`,
    [tx.businessId, callId, runner],
  );
  return row?.ok === true;
}

export function carriedCustody(options: CarriedCustodyOptions): Custody & {
  fenceIn(tx: TenantQuery, callId: string): Promise<boolean>;
} {
  const carrying: Carrying = { options, now: options.now ?? Date.now, runners: new Map() };
  return {
    pid: -1,
    dispatch: async (_credentialRef, request, onPiece, handoff) => {
      if (handoff === undefined) return refused('CARRIAGE_UNAVAILABLE');
      const topic = callTopic(handoff.businessId, handoff.callId);
      const joined = await options.carriage.join(topic, handoff.accessToken);
      if (!joined.ok) return refused('CARRIAGE_UNAVAILABLE');
      try {
        return await carry(
          carrying,
          joined.line,
          { request, ...(onPiece ? { onPiece } : {}) },
          handoff,
        );
      } finally {
        await joined.line.leave();
      }
    },
    // The function presents no credential: the agent's custody holds Ollama's, filed as `none`.
    describe: async () =>
      await Promise.resolve({ credentialKind: 'api_key', account: null, presents: false }),
    fenceIn: async (tx, callId) => {
      const runner = carrying.runners.get(callId);
      carrying.runners.delete(callId);
      return runner !== undefined && (await fenced(tx, callId, runner));
    },
    stderr: () => '',
    raw: async () => await Promise.resolve({ type: 'refused', code: 'CUSTODY_UNKNOWN_REQUEST' }),
    kill: nothing,
    stop: async () => {
      await Promise.resolve();
    },
  };
}
