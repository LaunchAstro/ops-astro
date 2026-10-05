// SPDX-License-Identifier: AGPL-3.0-only
// The approved occurrence's place counts the page's text only as the capture reads it: should the
// capture ever read a page otherwise than the check's blocks joined (a hidden element added on one
// side only), the occurrence has no place, so it never reads live, rather than being counted wrong.
import { expect, it, vi } from 'vitest';
import { occurrenceOf } from '../../packages/core-connectors/src/site/reconcile.ts';

const drift = vi.hoisted(() => ({ on: false }));
vi.mock('../../packages/core-connectors/src/capture/page.ts', async (actual) => {
  const page = await actual<typeof import('../../packages/core-connectors/src/capture/page.ts')>();
  return {
    ...page,
    readDocument: (html: string) => {
      const reading = page.readDocument(html);
      if (!drift.on || typeof reading === 'string') return reading;
      return { ...reading, text: reading.text.replace('We walk alongside you.', '').trim() };
    },
  };
});

const target = { path: 'src/pages/about.astro', word: 'alongside', replacement: 'beside' };
const before = '<aside>We walk alongside you.</aside>\n<p>We walk alongside you.</p>\n';
const change = {
  files: [
    {
      path: target.path,
      before,
      after: before.replace('<p>We walk alongside', '<p>We walk beside'),
    },
  ],
};

it('a page the capture reads otherwise than the check has no place for the occurrence', () => {
  expect(occurrenceOf(change, target)).toEqual({ left: 'We walk ', right: ' you.', index: 1 });
  drift.on = true;
  try {
    expect(occurrenceOf(change, target)).toBeUndefined();
  } finally {
    drift.on = false;
  }
});
