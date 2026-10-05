// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A refused appearance save reads the store again and puts the stored theme
// back. That reread can answer after its reader has gone: signed out, or
// switched to another reader. Its answer is the old reader's theme, so it
// must not reach the document or the tab's copy, or one person's appearance
// opens the sign-in page and the next person's session.

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { APPEARANCE_KEY, useStoredAppearance } from '../../apps/web/src/appearance.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { grantKeyOf, SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
  delete document.documentElement.dataset['themeFade'];
});

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** The app's wiring: the stored appearance always, You only while signed in. */
function Signed(props: {
  readonly client: OperationsClient;
  readonly grantKey: string | null;
}): ReactElement | null {
  useStoredAppearance(props.client, props.grantKey, window.sessionStorage);
  return props.grantKey === null ? null : (
    <YouGroups client={props.client} grantKey={props.grantKey} storage={window.sessionStorage} />
  );
}

/** Ada in Alpha, stored Dark, whose saves are refused and whose third read waits. */
function adasClient() {
  let reads = 0;
  let answer: ((response: Response) => void) | undefined;
  const fetch: typeof globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith('/preference/save')) {
      return Promise.resolve(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
      );
    }
    if (!url.endsWith('/preference/read')) throw new Error(`Unexpected request ${url}`);
    reads += 1;
    if (reads <= 2) return Promise.resolve(json({ preferences: { appearance: 'dark' } }));
    return new Promise<Response>((done) => {
      answer = done;
    });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    reads: () => reads,
    answerReread: async () => {
      await act(async () => {
        answer?.(json({ preferences: { appearance: 'dark' } }));
        await Promise.resolve();
      });
      await settle();
    },
  };
}

/** Another reader whose own stored appearance is Light. */
function lightReader(businessKey: string): OperationsClient {
  const fetch: typeof globalThis.fetch = (input) => {
    if (!String(input).endsWith('/preference/read')) throw new Error(`Unexpected ${String(input)}`);
    return Promise.resolve(json({ preferences: { appearance: 'light' } }));
  };
  return new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
}

async function chooseSystemAndBeRefused(ada: ReturnType<typeof adasClient>): Promise<void> {
  const system = view
    ?.all('[data-pref="appearance"] button')
    .find((button) => button.textContent === 'System');
  if (!(system instanceof HTMLButtonElement)) throw new Error('Missing the System button');
  await act(() => {
    system.click();
  });
  await settle();
  expect(ada.reads(), 'the refused save starts its reread').toBe(3);
}

it('a refused save’s late reread does not put the theme back after sign-out', async () => {
  const sessions = new SessionStore(null);
  sessions.set({ businessKey: 'alpha', email: 'ada@example.test' });
  const ada = adasClient();
  view = await mount(<Signed client={ada.client} grantKey={grantKeyOf(sessions.session)} />);
  await settle();
  expect(document.documentElement.dataset['themePreference']).toBe('dark');
  await chooseSystemAndBeRefused(ada);

  sessions.clear();
  await view.render(<Signed client={ada.client} grantKey={null} />);
  expect(document.documentElement.dataset['themePreference']).toBeUndefined();

  await ada.answerReread();
  expect(
    document.documentElement.dataset['themePreference'],
    'the signed-out reader’s theme came back onto the page',
  ).toBeUndefined();
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBeNull();
});

it('a refused save’s late reread does not repaint the next reader’s session', async () => {
  const sessions = new SessionStore(null);
  sessions.set({ businessKey: 'alpha', email: 'ada@example.test' });
  const ada = adasClient();
  view = await mount(<Signed client={ada.client} grantKey={grantKeyOf(sessions.session)} />);
  await settle();
  await chooseSystemAndBeRefused(ada);

  sessions.set({ businessKey: 'beta', email: 'ada@example.test' });
  const beta = lightReader('beta');
  await view.render(<Signed client={beta} grantKey={grantKeyOf(sessions.session)} />);
  await settle();
  expect(document.documentElement.dataset['themePreference']).toBe('light');

  await ada.answerReread();
  expect(
    document.documentElement.dataset['themePreference'],
    'the earlier reader’s theme replaced the new reader’s',
  ).toBe('light');
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBe('light');
});
