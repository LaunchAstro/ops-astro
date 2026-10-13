// SPDX-License-Identifier: AGPL-3.0-only
//
// The Realtime carriage: typed and inert until it is built.

import type { Carriage } from './carriage.ts';

export interface RealtimeCarriageOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly joinTimeoutMs?: number;
}

export function realtimeCarriage(_options: RealtimeCarriageOptions): Carriage {
  return { join: async () => await new Promise(() => {}) };
}
