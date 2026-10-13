// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent (live chat route B): inert until its code lands.

import { randomUUID } from 'node:crypto';
import type {
  Carriage,
  CarryKeys,
  CustodyOutcome,
  OutboundRequest,
} from '../../packages/core-custody/src/agent.ts';

/** Above this one-minute load the machine is too busy to start a model. */
export const BUSY_LOAD = 45;

/** Custody as the agent hands it a call: written by the deadline or not at all. */
export interface AgentCustody {
  dispatch(
    request: OutboundRequest,
    gate: { readonly deadlineAt: number; readonly onWritten: () => void },
    onPiece: (text: string) => void,
  ): Promise<CustodyOutcome>;
}

export interface ModelAgentOptions {
  readonly carriage: Carriage;
  readonly keys: CarryKeys;
  /** The current carry key, which the agent seals with. */
  readonly key: string;
  readonly business: string;
  readonly agent: string;
  /** The agent login's access token now. */
  readonly token: () => Promise<string>;
  readonly custody: AgentCustody;
  readonly now?: () => number;
  /** The machine's one-minute load. */
  readonly load?: () => number;
  /** Each thing the agent does, by kind only. */
  readonly log?: (kind: string) => void;
}

export interface ModelAgent {
  readonly runner: string;
  stop(): Promise<void>;
}

export async function startModelAgent(
  _options: ModelAgentOptions,
): Promise<ModelAgent | { readonly because: string }> {
  return await Promise.resolve({ runner: randomUUID(), stop: async () => {} });
}
