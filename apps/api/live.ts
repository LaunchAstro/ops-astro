// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the live task channel's fan-out. Not built yet.

import type { Listener } from '../../packages/core-records/src/index.ts';

export type LiveSignal = 'invalidate' | 'resync';

export interface LiveTopics {
  subscribe(businessId: string, taskId: string, send: (signal: LiveSignal) => void): () => void;
  readonly listening: boolean;
  close(): Promise<void>;
}

export function startLiveTopics(_listener: Listener): Promise<LiveTopics> {
  return Promise.reject(new Error('T2f: the fan-out is not built yet'));
}
