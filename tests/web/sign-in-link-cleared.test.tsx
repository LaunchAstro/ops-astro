// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in service's own link (invite, recovery, magic link, sign-up, address
// change) carries its tokens in the address's fragment. The app never reads
// them: the fragment is gone from the address bar and from the tab's history
// entry before the first draw, after Back or Forward, after a fragment-only
// move, and when a link to one is followed inside the app, where a pushed
// address fires neither `popstate` nor `hashchange`. The not-found page never
// prints a fragment. An address's own fragment stays.

import { act } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { follow, layout } from './frame-support.tsx';
import { granted, session, silent, storage } from './mp-2-1-support.tsx';

const LINKS = [
  ['recovery', '#access_token=planted-access&refresh_token=planted-refresh&type=recovery'],
  ['invite', '#access_token=planted-access&type=invite'],
  ['magic-link', '#access_token=planted-access&refresh_token=planted-refresh&type=magiclink'],
  ['sign-up', '#access_token=planted-access&type=signup'],
  ['address change', '#access_token=planted-access&type=email_change'],
  ['refresh-token', '#refresh_token=planted-refresh'],
] as const;

let undo: () => void = () => {};
beforeEach(() => {
  undo = layout();
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});
afterEach(() => {
  undo();
  window.history.replaceState(null, '', '/');
});

/** The real application root over jsdom's own history, signed in or out. */
async function rooted(address: string, signedIn: boolean): Promise<Mounted> {
  window.history.replaceState(null, '', address);
  const held = storage(signedIn ? { 'ops-astro.session': JSON.stringify(session('alpha')) } : {});
  const view = await mount(
    <Root
      window={window}
      sessions={new SessionStore(held.like)}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={silent}
      clientAccess={granted}
    />,
  );
  await settle();
  return view;
}

function clean(): void {
  expect(window.location.hash).toBe('');
  expect(window.location.href).not.toContain('planted');
  expect(JSON.stringify(window.history.state ?? null)).not.toContain('planted');
}

it.each(LINKS)('the %s link the tab lands on is cleared before the first draw', async (_, link) => {
  const view = await rooted(`/projects/${link}`, false);
  clean();
  expect(window.location.pathname).toBe('/projects/');
  expect(view.text()).not.toContain('planted');
  await view.unmount();
});

it('a link landing on an unknown address is cleared, and the not-found page prints no fragment', async () => {
  const view = await rooted(`/nowhere/${LINKS[0][1]}`, true);
  clean();
  expect(view.text()).not.toContain('planted');
  expect(view.text()).not.toContain('#');
  await view.unmount();
});

it('the not-found page prints an address without its fragment', async () => {
  const view = await rooted('/nowhere/#roadmap', true);
  expect(view.text()).toContain('/nowhere/');
  expect(view.text()).not.toContain('#roadmap');
  await view.unmount();
});

it.each(LINKS)('the %s link reached by a fragment-only move is cleared', async (_, link) => {
  const view = await rooted('/projects/', true);
  await act(async () => {
    const heard = new Promise((done) => {
      window.addEventListener('hashchange', done, { once: true });
    });
    window.location.hash = link.slice(1);
    await heard;
  });
  clean();
  await view.unmount();
});

it.each(LINKS)('the %s link followed inside the app is never pushed', async (_, link) => {
  const view = await rooted('/projects/', true);
  const anchor = document.createElement('a');
  anchor.setAttribute('href', `/settings${link}`);
  anchor.dataset['planted'] = '';
  anchor.textContent = 'a link someone pasted';
  const content = view.find('main') ?? view.find('.shell');
  if (content === null) throw new Error('no shell content to hold the link');
  content.append(anchor);
  const event = await follow(view, '[data-planted]');
  await settle();
  expect(event.defaultPrevented).toBe(true);
  expect(window.location.pathname).toBe('/settings');
  clean();
  // The entry the app pushed is the clean address: Back then Forward lands on it clean.
  await act(async () => {
    const back = new Promise((done) => {
      window.addEventListener('popstate', done, { once: true });
    });
    window.history.back();
    await back;
  });
  await act(async () => {
    const forward = new Promise((done) => {
      window.addEventListener('popstate', done, { once: true });
    });
    window.history.forward();
    await forward;
  });
  expect(window.location.pathname).toBe('/settings');
  clean();
  await view.unmount();
});

it('an address’s own fragment followed inside the app stays', async () => {
  const view = await rooted('/projects/', true);
  const anchor = document.createElement('a');
  anchor.setAttribute('href', '/settings#roadmap');
  anchor.dataset['own'] = '';
  const content = view.find('main') ?? view.find('.shell');
  if (content === null) throw new Error('no shell content to hold the link');
  content.append(anchor);
  await follow(view, '[data-own]');
  await settle();
  expect(window.location.hash).toBe('#roadmap');
  await view.unmount();
});
