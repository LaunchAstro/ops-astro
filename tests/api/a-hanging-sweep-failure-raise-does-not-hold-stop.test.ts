// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation sweep's `stop` waits for a pass in flight, so the pool
// outlives it, but not for the raise of a failure the pass reported: a raise
// that never answers would hold the server's shutdown past its grace period.
// Once stopped, the raise is no longer waited on.

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { startConversationSweeper } from '../../apps/api/conversation-sweeper.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

describe('the conversation sweep stopping', () => {
  it('resolves while a failure raise it started never answers', async () => {
    let raised!: () => void;
    const raising = new Promise<void>((resolve) => {
      raised = resolve;
    });
    const sweeper = startConversationSweeper({} as Database, {
      businesses: async () => await Promise.resolve(['business-one']),
      codeRevision: 'revision',
      sweep: async () =>
        await Promise.resolve({
          wrapped: [],
          purged: [],
          held: [],
          failed: [],
          windowUnreadable: true,
        }),
      raise: async () => {
        raised();
        await new Promise<void>(() => {
          // A raise that never answers.
        });
      },
    });
    await raising;
    const stopped = await Promise.race([
      sweeper.stop().then(() => 'stopped' as const),
      delay(1000, 'still waiting' as const),
    ]);
    expect(stopped).toBe('stopped');
  });
});
