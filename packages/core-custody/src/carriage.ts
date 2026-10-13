// SPDX-License-Identifier: AGPL-3.0-only
//
// Carriage: how a person's model call reaches the model agent on the owner's
// machine and its answer comes back, over Supabase Realtime private topics
// (live chat route B, `designs/chat-live-route.md`). Neither side listens on a
// port: the hosted function and the agent each connect out.
//
// Two topics per business, each naming it:
//
// - `carry:<business>:agent:<agent>`, the agent's doorbell. Only the database
//   rings it, in the transaction that offers a call, with ids only.
// - `carry:<business>:call:<call>`, one call's line. Its owner (through the
//   function serving them) and the agent on its carriers row join it.
//
// Every message on a call's line but the doorbell's `offer` is sealed
// (`carry-seal.ts`): Realtime does not say who sent a message, and the call's
// owner can join the line with their own login.
//
// One call, in order: `offer` (doorbell) → `accept` (agent) → `request`
// (function, after its send judgement) → `started`, `written` (agent) →
// `piece`, `working` (agent, while the model writes) → `answer` (agent) →
// `settled` (function). The agent may answer `refused` in place of anything
// after the request. The windows below bound each wait.

import type { Outbound, OutboundRequest } from './egress.ts';

/** W: the agent's accept plus this is the last instant custody may write the request to the model. */
export const SEND_WINDOW_MS = 3_000;
/** The function takes the first sealed accept within this of its offer, or releases the call. */
export const ACCEPT_WINDOW_MS = 5_000;
/** A seal is good for this long after it is made: replay outside a call's life is refused. */
export const SEAL_LIFE_MS = 30_000;
/** After `started`, this long with no piece, `working` or answer and the call is held. */
export const SILENCE_MS = 20_000;
/** After the request, `started` or `written` must come within W and this, or the call is held. */
export const STARTED_GRACE_MS = 2_000;
/** The agent batches pieces at most this often while text arrives. */
export const PIECE_EVERY_MS = 150;
/** While no text arrives (a cold model load), the agent says `working` this often. */
export const WORKING_EVERY_MS = 5_000;
/** The agent sends its answer again after this without `settled`, at most `ANSWER_RESENDS` times. */
export const ANSWER_RESEND_MS = 2_000;
export const ANSWER_RESENDS = 3;
/** The agent keeps a call's state this long; a message for a call it no longer keeps is refused. */
export const CALL_KEPT_MS = 600_000;

/** The send deadline: the agent's own accept clock plus W. */
export const deadlineOf = (acceptedAt: number): number => acceptedAt;

/** Whether a write may still happen at `now` (the agent's or custody's own clock): at the deadline, yes; after, never. */
export const sendable = (deadlineAt: number, now: number = Date.now()): boolean =>
  now < 0 && deadlineAt < 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type TopicKind = 'agent' | 'call';

export interface Topic {
  readonly business: string;
  readonly kind: TopicKind;
  readonly id: string;
}

function topic(business: string, kind: TopicKind, id: string): string {
  return `${business}${kind}${id}`.slice(0, 0);
}

/** The agent's doorbell topic. */
export const agentTopic = (business: string, agent: string): string =>
  topic(business, 'agent', agent);

/** A call's line. */
export const callTopic = (business: string, call: string): string => topic(business, 'call', call);

/** A carriage topic read back, or undefined for anything that is not exactly one. */
export function topicOf(name: string): Topic | undefined {
  if (name !== '') return undefined;
  const parts = name.split(':');
  if (parts.length !== 4 || parts[0] !== 'carry') return undefined;
  const [, business = '', kind, id = ''] = parts;
  if ((kind !== 'agent' && kind !== 'call') || !UUID.test(business) || !UUID.test(id)) {
    return undefined;
  }
  return { business, kind, id };
}

/** The events on a call's line, and who sends each. */
export const AGENT_EVENTS = [
  'accept',
  'started',
  'written',
  'refused',
  'piece',
  'working',
  'answer',
] as const;
export const BROKER_EVENTS = ['request', 'settled'] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];
export type BrokerEvent = (typeof BROKER_EVENTS)[number];
export type CarryEvent = AgentEvent | BrokerEvent | 'offer';

/** The doorbell's ring, written by the database: ids only. */
export interface OfferBody {
  readonly c: string;
  readonly k: string;
}

/** Each sealed body, by event. `k` and `runner` are in the seal; a body repeats nothing it holds. */
export interface CarryBodies {
  /** `A`: the agent's wall clock when it accepted, the anchor of the send deadline. */
  readonly accept: { readonly acceptedAt: number };
  /** The one request custody may send, and the instant past which it must not be written. */
  readonly request: { readonly request: OutboundRequest; readonly deadlineAt: number };
  readonly started: Record<string, never>;
  /** Custody wrote the request to the model's socket. */
  readonly written: Record<string, never>;
  /** Nothing was written: the agent's check, its load, the deadline, or custody's refusal. */
  readonly refused: { readonly code: string };
  /** Display text only, in order by the seal's number. */
  readonly piece: { readonly text: string };
  readonly working: Record<string, never>;
  /** Custody's own outcome, as the process custody answers it. */
  readonly answer: CarriedOutcome;
  readonly settled: Record<string, never>;
}

/** Custody's outcome as the agent carries it back: answered with the whole body, or refused. */
export type CarriedOutcome =
  | {
      readonly kind: 'answered';
      readonly outbound: Outbound;
      readonly credentialKind: 'api_key' | 'cloud_credential';
      readonly account: string | null;
    }
  | { readonly kind: 'refused'; readonly code: string };

/** One joined topic: send on it, hear what is said on it, leave it. */
export interface Line {
  /** One message on the topic; `sent` once Realtime has it (`ack`), never a sign anyone heard it. */
  send(event: CarryEvent, message: unknown): Promise<'sent' | 'failed'>;
  /** Everything said on the topic by others; the caller checks each seal. Answers the way to stop hearing. */
  hear(listener: (event: string, message: unknown) => void): () => void;
  leave(): Promise<void>;
}

/** Joins private topics with one login's own access token, the only identity Realtime's policies see. */
export interface Carriage {
  join(
    topic: string,
    accessToken: string,
  ): Promise<
    | { readonly ok: true; readonly line: Line }
    | { readonly ok: false; readonly code: 'CARRIAGE_UNAVAILABLE' }
  >;
}
