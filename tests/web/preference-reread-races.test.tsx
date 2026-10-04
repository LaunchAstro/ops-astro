// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  delete document.documentElement.dataset['themePreference'];
  delete document.documentElement.dataset['themeFade'];
});
function gate() {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function choice(label: string): HTMLButtonElement {
  const button = view
    ?.all('[data-pref="appearance"] button')
    .find((node) => node.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`);
  return button;
}
const refused = () =>
  Response.json(
    { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
    { status: 403 },
  );
const preferences = (appearance: string) => Response.json({ preferences: { appearance } });
const success = () => Response.json({ applied: true, revision: 1 });

it('a refused save reread cannot replace a newer queued appearance choice', async () => {
  const dark = gate();
  const light = gate();
  const reread = gate();
  let reads = 0;
  const writes: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/preference/read'))
      return ++reads === 1 ? Promise.resolve(preferences('system')) : reread.promise;
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body !== 'object' || body === null || !('value' in body))
      throw new Error('Missing preference value');
    writes.push(String(body.value));
    return body.value === 'dark' ? dark.promise : light.promise;
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  view = await mount(<YouGroups client={client} grantKey="alpha:ada" storage={null} />);
  await settle();
  await act(() => choice('Dark').click());
  await act(() => choice('Light').click());
  expect(choice('Light').getAttribute('aria-pressed')).toBe('true');
  await act(() => dark.release(refused()));
  await settle();
  expect(reads).toBe(2);
  expect(writes).toEqual(['dark', 'light']);
  // The reread captured System while the queued Light write had not committed.
  await act(() => light.release(success()));
  await settle();
  await act(() => reread.release(preferences('system')));
  await settle();
  expect(
    choice('Light').getAttribute('aria-pressed'),
    'Light was the latest choice and its save succeeded',
  ).toBe('true');
  expect(document.documentElement.dataset['themePreference']).toBe('light');
});

it.each([
  ['business to business', 'bravo', 'bravo:ada'],
  ['person to person', 'alpha', 'alpha:ben'],
])(
  '%s, a late refused-save reread cannot erase the new reader preferences',
  async (_boundary, businessKey, grantKey) => {
    const reread = gate();
    let reads = 0;
    const fetch: typeof globalThis.fetch = (input) =>
      String(input).endsWith('/preference/read')
        ? ++reads === 1
          ? Promise.resolve(preferences('dark'))
          : reread.promise
        : Promise.resolve(refused());
    const ada = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
    view = await mount(<YouGroups client={ada} grantKey="alpha:ada" storage={null} />);
    await settle();
    await act(() => choice('System').click());
    await settle();
    expect(reads).toBe(2);
    const next = new OperationsClient({
      origin: '',
      businessKey,
      signedIn: true,
      fetch: () => Promise.resolve(preferences('light')),
    });
    await view.render(<YouGroups client={next} grantKey={grantKey} storage={null} />);
    await settle();
    expect(choice('Light').getAttribute('aria-pressed')).toBe('true');
    await act(() => reread.release(preferences('dark')));
    await settle();
    expect(
      choice('Light').getAttribute('aria-pressed'),
      'the new reader already loaded Light',
    ).toBe('true');
  },
);
