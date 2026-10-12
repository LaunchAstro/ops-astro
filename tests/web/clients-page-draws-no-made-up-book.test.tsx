// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The application's Clients page and dock panel draw no made-up client book:
// no install, production included, shows sample clients as if they were the
// business's. A sentence says where clients are added for now.

import { afterEach, describe, expect, it } from 'vitest';
import { MADE_UP_BOOK } from '../../apps/web/src/data/clients-book.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { open } from './mp-2-1-support.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

const NOT_YET = 'Clients are added from the command line for now.';

describe('the application draws no made-up client book', () => {
  it('the Clients page names no sample client and says where clients are added', async () => {
    const { view } = await open('/clients/');
    live.push(view);
    const text = view.find('.clbook')?.textContent ?? '';
    expect(text).not.toContain('Sample data');
    for (const made of MADE_UP_BOOK.clients) expect(text).not.toContain(made.name);
    expect(view.find('.clbook [data-provenance="mock"]')).toBeNull();
    expect(view.find('.clbook__empty')?.textContent).toBe(NOT_YET);
  });
});
