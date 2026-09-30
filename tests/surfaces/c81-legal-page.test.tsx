// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C81's public legal page (CS-16.20): each public legal document at an address
// that needs no sign-in, drawn from the public read alone
// (`GET /api/public/b/:businessKey/legal/:document`), and linked from the
// sign-in page for the business chosen there. The API's one 404 is drawn as one
// not-published state, whatever was missing. The stand-in API answers the
// read's own shape (`apps/api/app.ts`, `mountPublicLegal`).

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const POLICY = {
  document: 'privacy-policy',
  version: '1.0',
  body: 'Part A. How we handle personal information.\n\nClaude and ChatGPT receive none.\n\nPart B. Collection notices.',
  digest: 'sha256:policy-1-0',
  publishedAt: '2026-09-28T02:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server(answer: () => Response) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), headers: new Headers(init?.headers) });
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
});

/** The app at `path` with nobody signed in. */
async function open(path: string, fetch: typeof globalThis.fetch): Promise<Mounted> {
  const held = new Map<string, string>();
  const sessions = new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
  const view = await mount(
    <App
      path={path}
      navigate={() => {
        // One address for the whole case.
      }}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />,
  );
  live.push(view);
  await settle();
  await settle();
  return view;
}

const hrefs = (view: Mounted): readonly string[] =>
  view.all('a[href^="/legal/"]').map((link) => link.getAttribute('href') ?? '');

describe('C81 public legal page, published', () => {
  it('C81 public without sign-in: the privacy policy draws with no session, from the public read alone', async () => {
    const api = server(() => json(POLICY));
    const view = await open('/legal/alpha/privacy-policy/', api.fetch);
    expect(view.find('.signin__form')).toBeNull();
    const page = view.find('[data-screen="legal"]');
    expect(page).not.toBeNull();
    const words = page?.textContent ?? '';
    expect(words).toContain('Privacy policy');
    expect(words).toContain('1.0');
    expect(words).toContain('2026-09-28');
    // The body's paragraphs, split on blank lines, as text and nothing else.
    const paragraphs = view.all('[data-screen="legal"] [data-paragraph]');
    expect(paragraphs.map((each) => each.textContent)).toEqual([
      'Part A. How we handle personal information.',
      'Claude and ChatGPT receive none.',
      'Part B. Collection notices.',
    ]);
    // The one public read, of this business and document, with no bearer.
    expect(api.asked.map((each) => each.url)).toEqual(['/api/public/b/alpha/legal/privacy-policy']);
    for (const each of api.asked) expect(each.headers.get('authorization')).toBeNull();
    // The business's other public documents, and the way back to sign-in.
    expect(hrefs(view)).toEqual(
      expect.arrayContaining(['/legal/alpha/client-terms/', '/legal/alpha/data-handling/']),
    );
    expect(view.find('a[href="/sign-in"]')).not.toBeNull();
  });
});

/** What the page says at `path` when the public read answers its one 404. */
async function notPublishedAt(path: string): Promise<string> {
  const api = server(() => json({ code: 'NOT_FOUND' }, 404));
  const view = await open(path, api.fetch);
  expect(view.find('.signin__form'), path).toBeNull();
  const state = view.find('[data-screen="legal"] [data-outcome="not-published"]');
  expect(state, path).not.toBeNull();
  expect(state?.textContent, path).toContain('This document is not published.');
  expect(view.find('[data-paragraph]'), path).toBeNull();
  const said = state?.textContent ?? '';
  // Unmounted here, one at a time: two `act`s at once in `afterEach` spoil the next case.
  live.splice(live.indexOf(view), 1);
  await view.unmount();
  return said;
}

describe('C81 public legal page, not published', () => {
  it('C81 public without sign-in: an unpublished or unknown document draws one not-published state', async () => {
    const said = [
      await notPublishedAt('/legal/zulu/privacy-policy/'),
      await notPublishedAt('/legal/alpha/breach-runbook/'),
    ];
    // One answer: nothing says whether the business exists.
    expect(said[0]).toBe(said[1]);
    expect(said[0]).not.toMatch(/zulu|business/iu);
  });
});

describe('C81 sign-in page', () => {
  it('C81 linked from sign-in: the sign-in page links each public document for the selected business', async () => {
    const api = server(() => json({}));
    const view = await open('/sign-in', api.fetch);
    expect(view.find('.signin__form')).not.toBeNull();
    const links = (): readonly (readonly [string, string])[] =>
      view
        .all('a[href^="/legal/"]')
        .map((link) => [link.getAttribute('href') ?? '', link.textContent ?? ''] as const);
    expect(links()).toEqual([
      ['/legal/alpha/privacy-policy/', 'Privacy policy'],
      ['/legal/alpha/client-terms/', 'Client terms'],
      ['/legal/alpha/data-handling/', 'Data handling'],
    ]);
    await view.choose('#signin-business', 'bravo');
    expect(links().map(([href]) => href)).toEqual([
      '/legal/bravo/privacy-policy/',
      '/legal/bravo/client-terms/',
      '/legal/bravo/data-handling/',
    ]);
    // Drawing the sign-in page reads nothing.
    expect(api.asked).toEqual([]);
  });
});
