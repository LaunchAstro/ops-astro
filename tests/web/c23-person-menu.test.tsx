// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C23, the signed-in person menu (CS-2.9, FA-SHELL-30): at the far right of the
// app strip, who is signed in in the presence-circle style, opening a menu with
// the person's name, a link to their own settings (You) and Sign out. The
// server half, `session.end` audited and `session.person`, is proved against
// the real database by `tests/commands/c23-session-end.test.ts` and
// `C23 isolation`; here the stand-in is the transport.

import { describe, expect, it, vi } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle } from './mp-2-1-support.tsx';
import { press } from './frame-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

/** Held open: a call nobody answers. */
const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

const trigger = (view: Mounted): Element | null => view.find('.appbar .who__trigger');

interface Asked {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  /** The sign-in the call names (S0-6c): the API reads that session's cookie only. */
  readonly session: string | null;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Signed in as `sid-alpha`, the id the API gave this tab's sign-in (S0-6c). */
const SIGNED_IN = {
  seed: {
    'ops-astro.session': JSON.stringify({
      businessKey: 'alpha',
      email: 'mia@alpha.local',
      sessionId: 'sid-alpha',
    }),
  },
};

/**
 * A transport answering the person's name, the sign-out and the API's clearing
 * of the session cookie, each by `answers`, and holding every other call.
 */
function transport(
  answers: {
    readonly person?: () => Promise<Response>;
    readonly end?: () => Promise<Response>;
    readonly clear?: () => Promise<Response>;
  } = {},
) {
  const asked: Asked[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const answer = url.endsWith('/session/person')
      ? (answers.person ?? (() => Promise.resolve(json({ person: { name: 'Mia Hart' } }))))
      : url === '/api/session/end'
        ? (answers.clear ?? (() => Promise.resolve(json({ ok: true }))))
        : url.endsWith('/session/end')
          ? (answers.end ??
            (() => Promise.resolve(json({ recordId: null, detail: { ended: 'sign-out' } }))))
          : null;
    if (answer === null) return await never();
    asked.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      session: headers.get(SESSION_HEADER),
      body,
    });
    return await answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const TRIGGER = '.appbar .who__trigger';

// eslint-disable-next-line max-lines-per-function -- one case per part of the capability row
describe('C23 CS-2.9: show who is signed in, sign out, and reach the person’s own preferences in /settings/ (You)', () => {
  it('shows the signed-in person in a presence circle at the far right of the strip', async () => {
    const { fetch } = transport();
    const { view } = await open('/projects/', { fetch });
    await settle();
    const circle = trigger(view);
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('aria-haspopup')).toBe('menu');
    expect(circle?.getAttribute('aria-expanded')).toBe('false');
    expect(circle?.getAttribute('aria-label')).toBe('Mia Hart, signed in');
    expect(view.find(`${TRIGGER} .av.av--person`)?.textContent).toBe('MH');
    // The far right: the strip's last element.
    expect(view.find('.appbar')?.lastElementChild?.contains(circle)).toBe(true);
    await view.unmount();
  });

  it('opens a menu with the name, a link to the person’s own settings, and Sign out', async () => {
    const { fetch } = transport();
    const { view } = await open('/projects/', { fetch });
    await settle();
    await view.click(TRIGGER);
    expect(trigger(view)?.getAttribute('aria-expanded')).toBe('true');
    const menu = view.find('.appbar .who__menu');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(view.find('.who__menu .who__name')?.textContent).toBe('Mia Hart');
    expect(view.find('.who__menu .who__email')?.textContent).toBe('mia@alpha.local');
    const items = view.all('.who__menu [role="menuitem"]');
    expect(items.map((item) => item.textContent)).toEqual(['Your settings', 'Sign out']);
    expect(items[0]?.getAttribute('href')).toBe('/settings');
    expect(document.activeElement).toBe(items[0]);
    await view.unmount();
  });

  it('the settings link goes to /settings (You) and closes the menu', async () => {
    const { fetch } = transport();
    const { view, seen } = await open('/projects/', { fetch });
    await settle();
    await view.click(TRIGGER);
    await view.click('.who__menu a[role="menuitem"]');
    expect(seen.at(-1)).toBe('/settings');
    expect(view.find('.who__menu')).toBeNull();
    await view.unmount();
  });

  it('Sign out records the sign-out for this session, clears its own session cookie only, and lands on sign-in', async () => {
    const { fetch, asked } = transport();
    const { view, seen, sessions } = await open('/projects/', { fetch, ...SIGNED_IN });
    await settle();
    await view.click(TRIGGER);
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    expect(sessions.session).toBeNull();
    expect(seen.at(-1)).toBe('/sign-in');
    const end = asked.find((each) => each.url.endsWith('/session/end'));
    expect(end).toMatchObject({
      url: '/api/b/alpha/session/end',
      method: 'POST',
      authorization: null,
      session: 'sid-alpha',
    });
    expect(typeof end?.body['operationId']).toBe('string');
    expect(Object.keys(end?.body ?? {})).toEqual(['operationId']);
    // This sign-in's cookie only, never the person's other sessions; the page
    // holds no token, so it asks the identity provider for nothing (S0-6c).
    const cleared = asked.find((each) => each.url === '/api/session/end');
    expect(cleared).toMatchObject({ method: 'POST', session: 'sid-alpha' });
    expect(asked.map((each) => each.url).filter((url) => url.includes('/logout'))).toEqual([]);
    expect(trigger(view)).toBeNull();
    await view.unmount();
  });

  it('Escape closes the menu and returns focus to the circle', async () => {
    const { fetch } = transport();
    const { view } = await open('/projects/', { fetch });
    await settle();
    await view.click(TRIGGER);
    await press(document.activeElement ?? document.body, 'Escape');
    expect(view.find('.who__menu')).toBeNull();
    expect(document.activeElement).toBe(trigger(view));
    await view.unmount();
  });

  it('is not drawn without a session', async () => {
    const { fetch } = transport();
    const { view } = await open('/sign-in/', { fetch, businessKey: null });
    await settle();
    expect(trigger(view)).toBeNull();
    await view.unmount();
  });

  it('shows the email the person signed in with while the name is unknown or refused', async () => {
    const refused = json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
    const { fetch } = transport({ person: () => Promise.resolve(refused) });
    const { view } = await open('/projects/', { fetch });
    await settle();
    expect(trigger(view)?.getAttribute('aria-label')).toBe('mia@alpha.local, signed in');
    expect(view.find(`${TRIGGER} .av`)?.textContent).toBe('M');
    await view.unmount();
  });
});

describe('C23 it draws no mockup surface: the kit’s avatar and menu, in the strip on both faces', () => {
  it('is the kit’s presence circle and menu, with no private look', async () => {
    const { fetch } = transport();
    const { view } = await open('/projects/', { fetch });
    await settle();
    await view.click(TRIGGER);
    expect(view.find('.who__menu')?.classList.contains('menu')).toBe(true);
    expect(view.all('.who__menu .menu__opt')).toHaveLength(2);
    // The old words in the page header are gone: one place says who is signed in.
    expect(view.find('.topbar__who')).toBeNull();
    await view.unmount();
  });

  it('is on the client face too, where a client signs out the same way', async () => {
    const { fetch } = transport();
    const { view } = await open('/portal/acme-dental/', { fetch });
    await settle();
    expect(view.find('.appbar[data-face="client"] .who__trigger')).not.toBeNull();
    await view.unmount();
  });
});

// eslint-disable-next-line max-lines-per-function -- the three ways a sign-out is answered
describe('C23 sign-out: check first, then act; it ends only its own session', () => {
  it('signs out even when neither the audit call nor the cookie route answers', async () => {
    const { fetch } = transport({ end: never, clear: never });
    const { view, seen, sessions } = await open('/projects/', { fetch, ...SIGNED_IN });
    await settle();
    await view.click(TRIGGER);
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    expect(sessions.session).toBeNull();
    expect(seen.at(-1)).toBe('/sign-in');
    await view.unmount();
  });

  it('signs out when either call fails, and draws nothing of the failure', async () => {
    const { fetch } = transport({
      end: () => Promise.reject(new TypeError('offline')),
      clear: () => Promise.resolve(json({ msg: 'no' }, 500)),
    });
    const { view, sessions } = await open('/projects/', { fetch, ...SIGNED_IN });
    await settle();
    await view.click(TRIGGER);
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    expect(sessions.session).toBeNull();
    expect(document.body.textContent).not.toContain('offline');
    expect(view.find('form')).not.toBeNull();
    await view.unmount();
  });

  it('a late answer to a sign-out touches nothing of the session signed in after it', async () => {
    let finish: ((value: Response) => void) | undefined;
    const late = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const { fetch, asked } = transport({ end: late });
    const { view, sessions } = await open('/projects/', { fetch, ...SIGNED_IN });
    await settle();
    await view.click(TRIGGER);
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    const next = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'sid-second' };
    sessions.set(next);
    finish?.(json({ refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: [] }, 401));
    await settle();
    expect(sessions.session).toEqual(next);
    // Every call named the ended sign-in, never the next one.
    expect(asked.every((each) => each.session === 'sid-alpha')).toBe(true);
    await view.unmount();
  });
});
