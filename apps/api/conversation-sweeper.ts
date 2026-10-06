// SPDX-License-Identifier: AGPL-3.0-only
//
// R7: the idle sweep on a schedule. The interface only, so the red cases load.

import type { SweepReport, SweepRequest } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

export const CONVERSATION_SWEEP_EVERY_MS = 0;

export type SweepFailureCause = 'wrap_up' | 'purge' | 'window_unreadable' | 'pass';

export interface SweepFailure {
  readonly businessId: string;
  readonly cause: SweepFailureCause;
  readonly conversationIds: readonly string[];
}

export interface SweeperOptions {
  readonly businesses: () => Promise<readonly string[]>;
  readonly codeRevision: string;
  readonly raise?: (failure: SweepFailure) => Promise<void> | void;
  readonly sweep?: (database: Database, request: SweepRequest) => Promise<SweepReport>;
  readonly lockTimeoutMs?: number;
}

export function sweepRound(_database: Database, _options: SweeperOptions): () => Promise<void> {
  return async () => {
    await Promise.resolve();
  };
}

export function startConversationSweeper(
  _database: Database,
  _options: SweeperOptions & { readonly everyMs?: number },
): { readonly stop: () => Promise<void> } {
  return {
    stop: async () => {
      await Promise.resolve();
    },
  };
}
