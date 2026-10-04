// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the receipt link keeps no credential-length run, however its path
// spells it. Unit cases on the validator; the stored and shown link is the
// database-bound proof beside it (receipt-link-keeps-no-credential).
import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { receiptLinkOf } from '../../packages/core-runtime/src/receipt-link.ts';

const HOST = 'receipts.stand-in.invalid';
const credential = createHmac('sha256', 'not a real key').update('canary').digest('base64url');
const escaped = (text: string, hex: (code: string) => string): string =>
  [...text].map((c) => `%${hex(c.charCodeAt(0).toString(16).padStart(2, '0'))}`).join('');

it.each([
  ['as sent', credential],
  ['in lowercase escapes', escaped(credential, (h) => h.toLowerCase())],
  ['in uppercase escapes', escaped(credential, (h) => h.toUpperCase())],
  [
    'escaped twice',
    escaped(
      escaped(credential, (h) => h),
      (h) => h,
    ),
  ],
  ['half escaped', `${credential.slice(0, 20)}${escaped(credential.slice(20), (h) => h)}`],
] as const)('a receipt link carrying a credential %s is recorded absent', (_case, path) => {
  expect(credential).toHaveLength(43);
  expect(receiptLinkOf(`https://${HOST}/effects/${path}`, 'synthetic_comment')).toBeNull();
});

it('a receipt link naming a UUID or an ordinary id is kept', () => {
  const uuid = `https://${HOST}/effects/0b6f3c9e-2f4a-4c1e-9d7b-5a8e2c1f0a3d`;
  const id = `https://${HOST}/effects/${'a'.repeat(42)}/1`;
  expect([
    receiptLinkOf(uuid, 'synthetic_comment'),
    receiptLinkOf(id, 'synthetic_comment'),
  ]).toEqual([uuid, id]);
});
