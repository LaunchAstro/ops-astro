// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { SecretListResult } from '../../packages/core-wire/src/index.ts';
import './c31-keys-panel.test.tsx';

// Run the submitted tests unchanged and observe the read-only fixture they use.
const readonlyLists: SecretListResult[] = [];
const original = OperationsClient.prototype.read;
const spy = vi.spyOn(OperationsClient.prototype, 'read').mockImplementation(async function (
  this: OperationsClient,
  name,
  body,
) {
  const result = await original.call(this, name, body);
  if (name === 'secret.list' && 'ok' in result) {
    const value = result.value as SecretListResult;
    if (!value.canChange) readonlyLists.push(value);
  }
  return result;
});

it('the submitted read-only test exercises a set row whose Clear control must be absent', () => {
  try {
    expect(readonlyLists.length).toBeGreaterThan(0);
    expect(
      readonlyLists.some((list) => list.secrets.some((secret) => secret.state === 'set')),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
