// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbox forwarder (S0-2 error outbox): not built yet.

import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import type { Where } from '../api/alerts/catalogue.ts';
import type { Transport } from '../api/alerts/sink.ts';

export interface ForwarderOptions {
  readonly database: AdminConnection;
  readonly send: Transport;
  readonly where: Where;
  readonly root: string;
  readonly release?: string;
  readonly heartbeat?: () => Promise<unknown>;
}

export function createForwarder(_options: ForwarderOptions): {
  readonly once: () => Promise<{ handled: number; dropped: number }>;
} {
  return { once: async () => await Promise.resolve({ handled: 0, dropped: 0 }) };
}
