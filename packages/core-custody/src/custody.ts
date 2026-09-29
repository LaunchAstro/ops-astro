// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

import type { StorableKind } from './credentials.ts';
import type { Destination, Outbound, OutboundRequest } from './egress.ts';

export type CustodyOutcome =
  | {
      readonly kind: 'answered';
      readonly started: boolean;
      readonly outbound: Outbound;
      readonly credentialKind: StorableKind;
      readonly account: string | null;
    }
  | { readonly kind: 'refused'; readonly started: false; readonly code: string }
  | { readonly kind: 'worker_lost'; readonly started: boolean; readonly fault: 'ours' };

export interface CustodyConfig {
  readonly credentialsFile: string;
  readonly destinations: readonly Destination[];
}

export interface Custody {
  readonly pid: number;
  dispatch(credentialRef: string, request: OutboundRequest): Promise<CustodyOutcome>;
  /** Everything custody wrote to stderr, for the canary proofs. */
  stderr(): string;
  /** Send a raw message, for the no-borrow proof: answers what custody replied. */
  raw(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
  stop(): Promise<void>;
}

export async function startCustody(_config: CustodyConfig): Promise<Custody> {
  await Promise.resolve();
  throw new Error('AW-01: not built');
}
