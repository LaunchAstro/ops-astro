// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6c, continued: `S0-6 isolation: one cookie per sign-in, many tabs` and
// `S0-6 content policy`. The helpers are session-cookie.fixture.ts; the
// invariant `S0-6 session cookie` and `S0-6 csrf` are in session-cookie.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SESSION_PATH, SESSION_HEADER, pathOf } from '../../packages/core-wire/src/index.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  ROOT,
  ISSUER,
  BOARD,
  SAME_ORIGIN,
  database,
  bearerFor,
  post,
  signInOf,
} from './session-cookie.fixture.ts';

function build() {
  const executeRead = vi.fn((_db: unknown, _business: string, presented: unknown) =>
    Promise.resolve({
      ok: true as const,
      presented,
    }),
  );
  const executeCommand = vi.fn(() => Promise.resolve({ recordId: 'r-1', revision: 1 }));
  const api = createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: (key) =>
      Promise.resolve(key === 'alpha' || key === 'bravo' ? `business-${key}` : undefined),
    executeRead: executeRead as never,
    executeCommand: executeCommand as never,
  });
  return { api, executeRead, executeCommand };
}

/** A tab naming `tab` (or nothing), in a browser holding the given sign-ins' cookies. */
async function fromTab(
  tab: string | undefined,
  held: readonly { readonly cookie: string }[],
  path = BOARD,
) {
  const { api, executeRead } = build();
  const headers: Record<string, string> = {
    cookie: held.map((one) => one.cookie).join('; '),
    ...SAME_ORIGIN,
  };
  if (tab !== undefined) headers[SESSION_HEADER] = tab;
  const answer = await post(api, path, headers);
  const reader = (executeRead.mock.calls[0]?.[2] as { subject?: string } | undefined)?.subject;
  return { answer, executeRead, reader };
}

describe('S0-6 isolation: one cookie per sign-in, many tabs', () => {
  isolationOneCookieCases1();
  isolationOneCookieCases2();
  isolationOneCookieCases3();
});

/**
 * Every script element on a page, and those that are not an empty same-origin
 * file. It reads each opening tag and what follows it, never a pairing with an
 * end tag, so `</script >`, `</script\t>` or an end tag with attributes cannot
 * hide a body: anything but whitespace before `</script` counts as inline.
 */
function scriptsOf(html: string) {
  const inline: string[] = [];
  let found = 0;
  for (const open of html.matchAll(/<script\b(?<attributes>[^>]*)>/giu)) {
    found += 1;
    const after = html.slice(open.index + open[0].length);
    const sameOrigin = /\ssrc="\/[^/]/u.test(open.groups?.['attributes'] ?? '');
    if (!sameOrigin || !/^\s*<\/script\b/iu.test(after)) inline.push(open[0]);
  }
  return { found, inline };
}

describe('S0-6 content policy', () => {
  const page = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="(?<policy>[^"]+)"/iu.exec(
    page,
  );
  const policy = meta?.groups?.['policy'] ?? '';
  const directive = (name: string) =>
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/u))
      .find(([key]) => key === name)
      ?.slice(1);

  it('the page carries a policy, ahead of every script, that runs only its own scripts', () => {
    expect(meta).not.toBeNull();
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script'));
    // Only same-origin files: no inline script, no eval, no other host.
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|nonce-|sha256-|\*/u);
  });

  it('the page itself has no inline script for the policy to have to allow', () => {
    const { found, inline } = scriptsOf(page);
    expect(found).toBeGreaterThan(0);
    expect(inline).toEqual([]);
  });

  it('the inline-script check catches hostile markup: odd end tags, case, a > in a quoted value', () => {
    const own = '<script type="module" src="/assets/index.js"></script>';
    expect(scriptsOf(own).inline).toEqual([]);
    for (const planted of [
      '<script>window.planted = 1;</script >',
      '<script>window.planted = 1;</script\t>',
      '<script>window.planted = 1;</script foo="bar">',
      '<SCRIPT>window.planted = 1;</SCRIPT>',
      '<script src="/a.js" data-x=">">window.planted = 1;</script>',
      '<script src="https://outside.example/a.js"></script>',
      '<script src="//outside.example/a.js"></script>',
    ]) {
      expect(scriptsOf(`${own}${planted}`).inline, planted).not.toEqual([]);
    }
  });
});

function isolationOneCookieCases1() {
  it('person crossover: a tab signed in as ada reads only as ada, never on mia’s cookie', async () => {
    const [ada, mia] = await Promise.all([signInOf('ada'), signInOf('mia')]);
    // Ada's own session is not in this browser: she is asked to sign in again.
    const gone = await fromTab(ada.id, [mia]);
    expect(gone.answer.status).toBe(401);
    expect(await gone.answer.json()).toMatchObject({ code: 'AUTH_UNKNOWN_LOGIN' });
    expect(gone.executeRead).not.toHaveBeenCalled();
    // Both cookies present: each tab reads as its own person.
    expect((await fromTab(ada.id, [mia, ada])).reader).toBe('ada');
    expect((await fromTab(mia.id, [ada, mia])).reader).toBe('mia');
  });

  it('client crossover: a client contact’s tab and a member’s tab each read only as themselves', async () => {
    const [contact, member] = await Promise.all([
      signInOf('client-contact-of-alpha'),
      signInOf('alpha-member'),
    ]);
    expect((await fromTab(contact.id, [member, contact])).reader).toBe('client-contact-of-alpha');
    expect((await fromTab(member.id, [contact, member])).reader).toBe('alpha-member');
    const crossed = await fromTab(contact.id, [member]);
    expect(crossed.answer.status).toBe(401);
    expect(crossed.executeRead).not.toHaveBeenCalled();
  });

  it('business crossover: the cookie names no business; the path does, and login resolution decides', async () => {
    const mia = await signInOf('mia');
    const bravo = await fromTab(mia.id, [mia], `/api/b/bravo${pathOf('task.board')}`);
    expect(bravo.answer.status).toBe(200);
    expect(bravo.executeRead.mock.calls[0]?.[1]).toBe('business-bravo');
    const nowhere = await fromTab(mia.id, [mia], `/api/b/charlie${pathOf('task.board')}`);
    expect(nowhere.answer.status).toBe(403);
    expect(await nowhere.answer.json()).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
    expect(nowhere.executeRead).not.toHaveBeenCalled();
  });
}

function isolationOneCookieCases2() {
  it('through the real API: an old tab’s late sign-out cannot clear a new tab’s session', async () => {
    /** One browser: the old tab signs out, a new sign-in lands first, then the old answer. */
    const race = async (old: string, fresh: string) => {
      const { api } = build();
      // The browser's jar, applying each answer's Set-Cookie in the order it lands.
      const jar = new Map<string, string>();
      const land = (answer: Response) => {
        for (const line of answer.headers.getSetCookie()) {
          const [pair = '', ...attributes] = line.split(';');
          const [name = '', ...value] = pair.trim().split('=');
          if (attributes.some((a) => a.trim().toLowerCase() === 'max-age=0')) jar.delete(name);
          else jar.set(name, value.join('='));
        }
      };
      const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const exchange = async (token: string) =>
        await post(api, SESSION_PATH, { authorization: `Bearer ${token}`, ...SAME_ORIGIN });

      land(await exchange(old));
      const late = post(api, `${SESSION_PATH}/end`, {
        cookie: cookie(),
        [SESSION_HEADER]: sessionIdOf(old),
        ...SAME_ORIGIN,
      });
      land(await exchange(fresh));
      land(await late);
      const board = await post(api, BOARD, {
        cookie: cookie(),
        [SESSION_HEADER]: sessionIdOf(fresh),
        ...SAME_ORIGIN,
      });
      return { oldGone: !jar.has(cookieNameFor(sessionIdOf(old))), status: board.status };
    };

    // Two people, and the same person twice: no late sign-out touches another sign-in.
    const outcomes = await Promise.all([
      race(await bearerFor('ada'), await bearerFor('mia')),
      race(await bearerFor('mia', 'first'), await bearerFor('mia', 'second')),
    ]);
    expect(outcomes).toEqual([
      { oldGone: true, status: 200 },
      { oldGone: true, status: 200 },
    ]);
  });
}

function isolationOneCookieCases3() {
  it('a tab that kept a session from before it had an id is refused, not trusted', async () => {
    const unnamed = await fromTab(undefined, [await signInOf('mia')]);
    expect(unnamed.answer.status).toBe(403);
    expect(await unnamed.answer.json()).toMatchObject({ code: 'AUTH_SESSION_MISMATCH' });
    expect(unnamed.executeRead).not.toHaveBeenCalled();
  });

  it('the browser client names its tab’s sign-in on every call', async () => {
    const sent: Record<string, string>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      sessionId: 'a'.repeat(32),
      fetch,
    });
    await client.read('task.board', {});
    await client.mutate('task.create', { title: 'x' });
    expect(sent.map((headers) => headers[SESSION_HEADER])).toEqual([
      'a'.repeat(32),
      'a'.repeat(32),
    ]);
  });
}
