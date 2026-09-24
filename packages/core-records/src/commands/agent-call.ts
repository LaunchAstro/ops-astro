// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of one agent call, and nothing else. Types only, so every agent
// module can depend on it without depending on the operation table
// (THERMO-RECHECK NA5).

import type { AgentSession } from '../identity/agent-login.ts';
import type { CommandName } from './surface.ts';

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
}

/** The operands an agent command takes beyond its identifiers, parsed rather than coerced. */
export interface AgentOperands {
  readonly leaseSeconds?: number;
  readonly report?: Readonly<Record<string, unknown>>;
  readonly reservationId?: string;
  readonly fence?: number;
  readonly outcome?: string;
}
