// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof: run the PR's entire regression suite while observing the real
// agent-to-custody boundary. Its three assertions pass without a single chat
// reaching that boundary, so they cannot establish the #1667 chat behaviour.
import { expect, it, vi } from 'vitest';
import type { ModelAgentOptions } from '../../apps/model-agent/carrier.ts';

// A plain list, not a `vi.fn`: vitest 5 clears a mock's calls before each test,
// so the suite's chats would be gone by the time this file's test counts them.
const observed = vi.hoisted(() => ({ dispatched: [] as unknown[] }));

vi.mock('../../apps/model-agent/carrier.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../apps/model-agent/carrier.ts')>();
  return {
    ...original,
    startModelAgent: (options: ModelAgentOptions) =>
      original.startModelAgent({
        ...options,
        custody: {
          dispatch: async (...args) => {
            observed.dispatched.push(args);
            return await options.custody.dispatch(...args);
          },
        },
      }),
  };
});

await import('./the-agent-logs-an-accept-only-once-realtime-took-it.test.ts');

it('the accept-log suite exercises a chat request reaching the model boundary', () => {
  expect(
    observed.dispatched.length,
    'All three supplied tests passed, but zero chat requests reached custody; no first Gemma message, follow-up model, or history was exercised',
  ).toBeGreaterThan(0);
});
