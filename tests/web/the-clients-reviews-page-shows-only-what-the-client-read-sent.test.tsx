// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's Projects > Reviews (PROTO-GAPS row 7) reads `review.client_list` and draws
// each review's revision, its approval, the client comments and pins on it and each change
// request's state; it reads no team review. A refusal stays a refusal, and an address naming
// a client the person holds no grant on draws the shared refusal and asks nothing.

import { expect, it } from 'vitest';
import { open, json, settle } from './mp-2-1-support.tsx';

const REVIEW = {
  reviewId: '95f65248-5a50-4101-835f-cdcbae93ad6c',
  kind: 'page',
  pageUrl: 'https://alpha.example/about',
  path: 'src/pages/about.astro',
  revision: 2,
  approved: { decidedAt: '2026-10-20 06:00:00+00' },
  comments: [
    {
      id: 'c1',
      body: 'Can the heading sit above the photo?',
      anchor: { source: 'r2', width: 390, selector: [] },
    },
    { id: 'c2', body: 'Thanks, the rest looks right.' },
  ],
  changeRequests: [{ changeRequestId: 'q1', commentId: 'c1', state: 'approved' }],
};

it('the client Reviews page draws what the client read sent, and reads nothing else', async () => {
  const asked: string[] = [];
  const page = await open('/portal/acme-dental/projects/reviews/', {
    fetch: (url) => {
      asked.push(String(url));
      return Promise.resolve(
        String(url).endsWith('/review/client_list')
          ? json({ ok: true, reviews: [REVIEW] })
          : new Response(null, { status: 404 }),
      );
    },
  });
  await settle();
  expect(page.view.find('[data-outcome="placeholder"]')).toBeNull();
  const review = page.view.find(`[data-client-review="${REVIEW.reviewId}"]`);
  expect(review?.textContent).toContain('https://alpha.example/about');
  expect(review?.textContent).toContain('Revision 2');
  expect(page.view.find('[data-decision="approved"]')?.textContent).toBe('Approved 2026-10-20');
  expect(page.view.find('[data-client-comment="c1"]')?.textContent).toContain(
    'Pinned on the phone view',
  );
  expect(page.view.find('[data-client-comment="c2"]')?.textContent).toContain('Thanks');
  expect(page.view.find('[data-change-state="approved"]')?.textContent).toBe('Change approved');
  expect(asked.filter((url) => /\/review\/(read|picture|list)$/u.test(url))).toStrictEqual([]);
});

it("another client's address draws the shared refusal and never asks the read", async () => {
  const asked: string[] = [];
  const page = await open('/portal/zenith-plumbing/projects/reviews/', {
    fetch: (url) => {
      asked.push(String(url));
      return Promise.resolve(json({ ok: true, reviews: [REVIEW] }));
    },
  });
  await settle();
  expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(page.view.all('[data-client-review]')).toHaveLength(0);
  expect(asked.filter((url) => url.includes('/review/'))).toStrictEqual([]);
});

it('a refusal shows the refusal and no review', async () => {
  const page = await open('/portal/acme-dental/projects/reviews/', {
    fetch: () =>
      Promise.resolve(
        json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask a holder.'] },
          403,
        ),
      ),
  });
  await settle();
  expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(page.view.all('[data-client-review]')).toHaveLength(0);
});
