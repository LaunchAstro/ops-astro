// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The application's Clients page and dock panel draw no made-up client book:
// no install, production included, shows sample clients as if they were the
// business's. The book the page draws is `client.list`'s
// (clients-real-book.test.tsx); this holds the made-up names out.

import { afterEach, describe, expect, it } from 'vitest';
import type { Mounted } from '../surfaces/mount.tsx';
import { open } from './mp-2-1-support.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

/** The eight businesses the deleted `data/clients-book.ts` made up. */
const MADE_UP_NAMES = [
  'Harbour Physio',
  'Kestrel Dental',
  'Banksia Allied Health',
  'Tidewater Chiropractic',
  'Wattle Street Podiatry',
  'Ironbark Legal',
  'Saltbush Kitchen',
  'Lorikeet Pilates',
];

describe('the application draws no made-up client book', () => {
  it('the Clients page names no sample client and carries no mock mark', async () => {
    const { view } = await open('/clients/');
    live.push(view);
    const text = view.find('.clbook')?.textContent ?? '';
    expect(view.find('.clbook')).not.toBeNull();
    expect(text).not.toContain('Sample data');
    for (const made of MADE_UP_NAMES) expect(text).not.toContain(made);
    expect(view.find('.clbook [data-provenance="mock"]')).toBeNull();
  });
});
