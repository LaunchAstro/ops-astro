// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The enrolment page takes its link's token from the fragment once, and
// clears it from the address bar and the history entry before it draws or
// asks anything. Accepting sends the token alone, never a password, and the
// page has no password field: the password is set from the mailed link. Every
// link that cannot be used reads alike, whatever the answer's code.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { EnrolScreen } from '../../apps/web/src/screens/Enrol.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

const TOKEN = 'planted_token_planted_token_planted_token_00';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

function answering(status: number, seen: { url: string; body: string; hashThen: string }[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body), hashThen: window.location.hash });
    return await Promise.resolve(new Response('{}', { status }));
  }) as typeof globalThis.fetch;
}

async function arrive(status: number) {
  window.history.replaceState({ at: 0 }, '', `/enrol/#${TOKEN}`);
  const seen: { url: string; body: string; hashThen: string }[] = [];
  const hashAtDraw: string[] = [];
  const view = await mount(
    <EnrolScreen
      path={`/enrol/#${TOKEN}`}
      apiOrigin=""
      fetch={answering(status, seen)}
      tab={{
        location: window.location,
        history: new Proxy(window.history, {
          get(target, key) {
            if (key === 'replaceState') {
              return (...args: Parameters<History['replaceState']>) => {
                target.replaceState(...args);
                hashAtDraw.push(window.location.hash);
              };
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      }}
    />,
  );
  await settle();
  return { view, seen, hashAtDraw };
}

async function press(view: Awaited<ReturnType<typeof mount>>): Promise<void> {
  const button = view.find('[data-screen="enrol"] button') as HTMLButtonElement | null;
  if (button === null) throw new Error('no accept button');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
}

it('clears the token from the address before it draws, and keeps it out of the history entry', async () => {
  const { view, hashAtDraw } = await arrive(200);
  expect(hashAtDraw).toStrictEqual(['']);
  expect(window.location.href).not.toContain(TOKEN);
  expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
  expect(view.text()).not.toContain(TOKEN);
  await view.unmount();
});

it('has no password field, and accepting sends the token alone after the address is clear', async () => {
  const { view, seen } = await arrive(200);
  expect(view.find('input[type="password"]')).toBeNull();
  await press(view);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe('/api/enrol');
  expect(JSON.parse(seen[0]?.body ?? '{}')).toStrictEqual({ token: TOKEN });
  expect(seen[0]?.hashThen).toBe('');
  expect(view.find('[data-outcome="accepted"]')).not.toBeNull();
  await view.unmount();
});

it('reads every unusable link alike', async () => {
  const words: string[] = [];
  for (const status of [401, 400]) {
    // eslint-disable-next-line no-await-in-loop -- one arrival at a time
    const { view } = await arrive(status);
    // eslint-disable-next-line no-await-in-loop -- one arrival at a time
    await press(view);
    words.push(view.find('[data-outcome]')?.textContent ?? '');
    // eslint-disable-next-line no-await-in-loop -- one arrival at a time
    await view.unmount();
  }
  expect(words[0]).not.toBe('');
  expect(words[1]).toBe(words[0]);
});
