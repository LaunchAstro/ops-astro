// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { consoleDuring } from './api-2-agent-credential-use-world.ts';

const credential = 'sol-814-made-up-credential';
const nested = { a: { b: { c: { d: { e: { credential } } } } } };

it('the secret-log capture keeps a credential nested deep in a percent-s argument', async () => {
  const captured = await consoleDuring(() => {
    console.error('fault: %s', nested);
    return Promise.resolve();
  });
  expect(captured).toContain(credential);
});

it('the secret-log capture keeps a credential nested deep in a percent-o argument', async () => {
  const captured = await consoleDuring(() => {
    console.error('fault: %o', nested);
    return Promise.resolve();
  });
  expect(captured).toContain(credential);
});

it('the secret-log capture keeps the plain text a logged Buffer carries', async () => {
  const bytes = Buffer.from(credential);
  // The previous String(part) capture retained this value.
  expect(String(bytes)).toContain(credential);
  const captured = await consoleDuring(() => {
    console.error(bytes);
    return Promise.resolve();
  });
  // Both plain text and reversible hex disclose every credential byte.
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  expect(captured.includes(credential) || captured.includes(hex)).toBe(true);
  expect(captured).toContain(credential);
});
