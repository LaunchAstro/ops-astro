// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Projects > Reviews (MP-8-1) reads `review.list` and links each review to its workspace
// address; a refusal stays a refusal, and a late list from the reader before a business
// switch never fills the page after it.

import { expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { mount } from '../surfaces/mount.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { App } from '../../apps/web/src/App.tsx';
import { open, json, settle, storage, session } from './mp-2-1-support.tsx';
import { lit } from './frame-support.tsx';

const REVIEW = {
  reviewId: '95f65248-5a50-4101-835f-cdcbae93ad6c',
  taskId: 'd0425b4d-0000-4000-8000-000000000000',
  kind: 'page',
  pageUrl: 'https://alpha.example/about',
  path: 'src/pages/about.astro',
  partyId: 'c1111111-1111-4111-8111-111111111111',
  revisionCount: 2,
  openPins: 3,
  openChangeRequests: 1,
  latest: 'undecided',
  updatedAt: '2026-10-20T06:00:00.000Z',
};

it('Projects > Reviews lists each review and links it to its workspace', async () => {
  const page = await open('/projects/reviews/', {
    fetch: (url) =>
      Promise.resolve(
        String(url).endsWith('/review/list')
          ? json({ ok: true, reviews: [REVIEW] })
          : String(url).endsWith('/client/list')
            ? json({
                ok: true,
                clients: [
                  { clientId: 'c1111111-1111-4111-8111-111111111111', name: 'Made-up Physio' },
                ],
              })
            : new Response(null, { status: 404 }),
      ),
  });
  await settle();
  expect(lit(page.view)).toEqual(['Projects']);
  expect(page.view.find('[data-outcome="placeholder"]')).toBeNull();
  const link = page.view.find(`a[href="/projects/reviews/${REVIEW.reviewId}"]`);
  expect(link?.textContent).toContain('https://alpha.example/about');
  expect(page.view.text()).toContain('Revision 2');
  expect(page.view.text()).toContain('Waiting for a decision');
  expect(page.view.find('[data-review-client]')?.textContent).toBe('Made-up Physio');
  expect(page.view.text()).toContain('3 open pins');
  expect(page.view.text()).toContain('1 open change request');
});

it('an empty list says no review is open, and a refusal shows the refusal', async () => {
  const empty = await open('/projects/reviews/', {
    fetch: () => Promise.resolve(json({ ok: true, reviews: [] })),
  });
  await settle();
  expect(empty.view.find('[data-outcome="empty"]')).not.toBeNull();
  await empty.view.unmount();
  const refused = await open('/projects/reviews/', {
    fetch: () =>
      Promise.resolve(
        json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask a holder.'] },
          403,
        ),
      ),
  });
  await settle();
  expect(refused.view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(refused.view.all('[data-review] a')).toHaveLength(0);
});

function ReaderSwitch(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly onSwitch: () => void;
}): ReactElement {
  const [, refresh] = useState(0);
  return (
    <>
      <button
        onClick={() => {
          props.sessions.set({ businessKey: 'bravo', email: 'ada@alpha.local' });
          props.onSwitch();
          refresh((n) => n + 1);
        }}
      >
        Switch business
      </button>
      <App
        path="/projects/reviews/"
        navigate={() => {}}
        sessions={props.sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        storage={null}
        fetch={props.fetch}
      />
    </>
  );
}

it('a late review list from before a business switch never fills the page after it', async () => {
  let answerLate: ((answer: Response) => void) | undefined;
  let switched = false;
  const sessions = new SessionStore(
    storage({ 'ops-astro.session': JSON.stringify(session('alpha')) }).like,
  );
  const fetch: typeof globalThis.fetch = (url) => {
    if (!String(url).endsWith('/review/list')) return new Promise<Response>(() => {});
    if (!switched)
      return new Promise<Response>((resolve) => {
        answerLate = resolve;
      });
    return Promise.resolve(json({ ok: true, reviews: [] }));
  };
  const view = await mount(
    <ReaderSwitch sessions={sessions} fetch={fetch} onSwitch={() => (switched = true)} />,
  );
  await settle();
  expect(answerLate).toBeTypeOf('function');
  await view.click('button');
  await settle();
  answerLate?.(json({ ok: true, reviews: [REVIEW] }));
  await settle();
  expect(view.find('[data-outcome="empty"]')).not.toBeNull();
  expect(view.find(`a[href="/projects/reviews/${REVIEW.reviewId}"]`)).toBeNull();
});
