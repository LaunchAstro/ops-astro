// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of one agent call, and nothing else. Types only, so every agent
// module can depend on it without depending on the operation table
// (THERMO-RECHECK NA5).

import type { AgentSession } from '../identity/agent-login.ts';
import type { CommandDeclaration, CommandName } from './surface.ts';

/**
 * What an agent sends.
 *
 * The credential is **not** in it. It arrives beside the request the way the
 * bearer token does, because it is a credential rather than a field: a payload
 * field is something the command is about, and a body that carried its own
 * authority would be a body that could be logged, replayed into a register row
 * and compared by a digest.
 */
export interface AgentRequest {
  readonly command: CommandName;
  readonly operationId: string;
  readonly [field: string]: unknown;
}

/** One agent call: who is calling, under what credential, asking what. */
export interface AgentCall {
  readonly session: AgentSession;
  readonly credential: string | undefined;
  readonly request: AgentRequest;
  /**
   * The request's own surface row, resolved once by the entry, so no later
   * step looks it up again or invents a collection or action for a miss.
   */
  readonly declaration: CommandDeclaration;
}

/**
 * The operands each agent row reads beyond its identifiers, parsed rather than
 * coerced. Each row's parser returns its own type, so a field its parser
 * guarantees is carried typed and nothing downstream invents a value for it
 * (THERMO-RECHECK-2 NNA3).
 */
export type NoOperands = Readonly<Record<never, never>>;

/** A lease length, when the caller sent one: `task.heartbeat`. */
export interface LeaseOperands {
  readonly leaseSeconds?: number;
}

/** The reservation `task.pickup` claims, and the lease length it asks for. */
export interface PickupOperands extends LeaseOperands {
  readonly reservationId: string;
}

/** What `task.handback` reads by type before any authority. */
export interface HandbackOperands {
  readonly outcome: string;
  readonly fence: number;
  readonly report?: Readonly<Record<string, unknown>>;
}
