// SPDX-License-Identifier: AGPL-3.0-only
//
// On the M5's internal network a DNS lookup of the root's DMARC record may
// fail for want of a resolver. DMARC is reported, never required, so the mail
// unit's reader answers no record where the lookup fails, and the records it
// does find pass through unchanged.

import { expect, it } from 'vitest';
import { txtOrNone } from '../../apps/mail/dmarc.ts';

it('a failed lookup reads as no record; a found record passes through', async () => {
  const fault = Object.assign(new Error('no resolver'), { code: 'ECONNREFUSED' });
  await expect(
    txtOrNone(async () => await Promise.reject(fault))('_dmarc.example.test'),
  ).resolves.toEqual([]);
  const found = [['v=DMARC1; ', 'p=reject']];
  await expect(
    txtOrNone(async () => await Promise.resolve(found))('_dmarc.example.test'),
  ).resolves.toBe(found);
});
