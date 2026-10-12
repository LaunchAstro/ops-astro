// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Closing search gives focus back to the strip's box once the palette has
// gone; a hit that navigates gives none back. Each key and click here is its
// own event, as a person makes them, so React settles each before the next.

import { act, useState, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { mount } from '../surfaces/mount.tsx';
import { press } from './frame-support.tsx';
import { json, open, settle, storage } from './mp-2-1-support.tsx';

const HIT = { id: 'task-1', key: 'ABC-1', title: 'Acme brochure' };
const BOX = '.appbar .appbar__search';

const pages: Mounted[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.unmount()));
});

/** Answers `task.search` with one hit and holds every other call. */
const searching: typeof globalThis.fetch = async (input) =>
  String(input).endsWith('/task/search')
    ? json({ ok: true, hits: [HIT] })
    : await new Promise<Response>(() => {
        /* never answers */
      });

async function pause(): Promise<void> {
  await act(async () => {
    await new Promise((done) => {
      setTimeout(done, 250);
    });
  });
  await settle();
}

async function pickHit(view: Mounted): Promise<void> {
  await view.type('.palette input', 'acme');
  await pause();
  await view.click('.palette [role="option"]');
}

it('a hit picked after Escape and ⌘K reopened search leaves focus off the box', async () => {
  const { view, seen } = await open('/projects/', { fetch: searching });
  pages.push(view);
  await view.click(BOX);
  await press(document.activeElement ?? document.body, 'Escape');
  await press(document.body, 'k', { metaKey: true });
  expect(document.activeElement, 'the reopened palette keeps its field focused').toBe(
    view.find('.palette input'),
  );
  await pickHit(view);
  expect(seen.at(-1)).toBe('/task/ABC-1');
  expect(document.activeElement).not.toBe(view.host.querySelector(BOX));
});

it('a hit that navigates gives no focus back to the box', async () => {
  const { view, seen } = await open('/projects/', { fetch: searching });
  pages.push(view);
  await view.click(BOX);
  await pickHit(view);
  expect(seen.at(-1)).toBe('/task/ABC-1');
  expect(view.find('.palette')).toBeNull();
  expect(document.activeElement).not.toBe(view.host.querySelector(BOX));
});

/** Signs in, says who is signed in, and holds every other call. */
const through: typeof globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('http://identity.invalid/token'))
    return json({ access_token: 'made-up-token' });
  if (url === '/api/session') return json({ ok: true, session: 'made-up-session' });
  if (url.endsWith('/session/person')) return json({ ok: true, person: { name: 'Ada' } });
  if (url.endsWith('/session/capabilities')) return json({ ok: true, grants: [] });
  return await new Promise<Response>(() => {
    /* never answers */
  });
};

/** Signs in to alpha with a held address that offers the switch to bravo. */
async function signedIn(): Promise<Mounted> {
  const tab = storage({
    'ops-astro.return-to': JSON.stringify({
      address: '/task/B-1',
      businessKey: 'bravo',
      code: 'AUTH_SESSION_EXPIRED',
    }),
  });
  const sessions = new SessionStore(tab.like);
  function Harness(): ReactElement {
    const [path, navigate] = useState('/sign-in');
    return (
      <App
        path={path}
        navigate={navigate}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={through}
        storage={null}
      />
    );
  }
  const page = await mount(<Harness />);
  pages.push(page);
  await page.choose('#signin-business', 'alpha');
  await page.type('#signin-email', 'person@example.test');
  await page.type('#signin-password', 'made-up-password');
  await page.click('form.signin__form button[type="submit"]');
  await settle();
  return page;
}

it('Escape after a business switch gives focus to the box drawn now', async () => {
  const page = await signedIn();
  await page.click('.appbar__search');
  await page.click('[data-switch="held-address"]');
  await settle();
  expect(page.find('.palette')).not.toBeNull();
  await press(document.activeElement ?? document.body, 'Escape');
  expect(page.find('.palette')).toBeNull();
  const box = page.find('.appbar__search');
  expect(box?.isConnected).toBe(true);
  expect(document.activeElement).toBe(box);
});
