// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { consoleDuring } from './api-2-agent-credential-use-world.ts';

it('the secret-log capture keeps a credential logged inside an object', async () => {
  const credential = 'sol-proof-made-up-credential-not-a-real-secret';
  const captured = await consoleDuring(() => {
    console.error({ credential });
    return Promise.resolve();
  });
  expect(captured, 'the leak detector must retain the secret before testing its absence').toContain(
    credential,
  );
});
