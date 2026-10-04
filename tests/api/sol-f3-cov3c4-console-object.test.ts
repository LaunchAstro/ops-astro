// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { consoleDuring } from './api-2-agent-credential-use-world.ts';

it('Sol proof, criterion 2: the secret-log capture preserves a credential logged in an object', async () => {
  const credential = 'sol-proof-made-up-credential-not-a-real-secret';
  const captured = await consoleDuring(() => {
    console.error({ credential });
    return Promise.resolve();
  });
  expect(captured, 'the leak detector must retain the secret before testing its absence').toContain(
    credential,
  );
});
