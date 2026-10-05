// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

const refusal = (code: string) =>
  Response.json({ refused: true, code, names: [], fixes: [] }, { status: 403 });

it.each([
  ['business to business', 'bravo', 'bravo:ada'],
  ['person to person', 'alpha', 'alpha:ben'],
])(
  '%s: a late save refusal keeps the current reader refusal',
  async (_boundary, businessKey, grantKey) => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const old = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: (input) =>
        String(input).endsWith('/preference/read')
          ? Promise.resolve(Response.json({ preferences: { appearance: 'light' } }))
          : pending,
    });
    const view = await mount(<YouGroups client={old} grantKey="alpha:ada" storage={null} />);
    await settle();
    const dark = view
      .all('[data-pref="appearance"] button')
      .find((button) => button.textContent === 'Dark');
    if (!(dark instanceof HTMLButtonElement)) throw new Error('Missing Dark choice');
    await act(() => dark.click());
    await settle();
    const next = new OperationsClient({
      origin: '',
      businessKey,
      signedIn: true,
      fetch: () => Promise.resolve(refusal('SCOPE_NOT_GRANTED')),
    });
    await view.render(<YouGroups client={next} grantKey={grantKey} storage={null} />);
    await settle();
    expect(view.find('[data-pref="refusal"]')?.textContent).toBe('SCOPE_NOT_GRANTED.');
    await act(() => release(refusal('VALIDATION_FAILED')));
    await settle();
    expect(
      view.find('[data-pref="refusal"]')?.textContent,
      'the new reader refusal must survive the old reader settlement',
    ).toBe('SCOPE_NOT_GRANTED.');
  },
);
