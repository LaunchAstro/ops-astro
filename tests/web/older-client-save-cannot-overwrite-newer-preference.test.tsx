// SPDX-License-Identifier: AGPL-3.0-only
// Proof from the independent review of the preference saves, retitled by what it proves; its body is as written.
// @vitest-environment jsdom

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { adaToken, call, read, usePreferencesWorld } from '../api/preferences-world.ts';

usePreferencesWorld('olderclientsave');

it('a refreshed sign-in client cannot let an older appearance save overwrite the latest choice', async () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced by the resolver below
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let older: Promise<Response> | undefined;
  const send = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const saving = String(input).endsWith('/preference/save');
    if (saving && body['value'] === 'dark') await gate;
    const answer = await call(saving ? 'preference.save' : 'preference.read', body, adaToken);
    expect(answer.status).toBe(200);
    return Response.json(answer.body, { status: answer.status });
  };
  const first = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      const response = send(input, init);
      if (String(input).endsWith('/preference/save')) older = response;
      return response;
    },
  });
  const latest = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: send,
  });
  const view = await mount(<YouGroups client={first} grantKey="alpha:ada:0" storage={null} />);
  const choose = async (label: string): Promise<void> => {
    const button = view
      .all('[data-pref="appearance"] button')
      .find((node) => node.textContent === label);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
    await act(async () => {
      button.click();
    });
    await settle();
  };
  try {
    await settle();
    await choose('Dark');
    expect(older).toBeDefined();
    await view.render(<YouGroups client={latest} grantKey="alpha:ada:0" storage={null} />);
    await settle();
    await choose('Light');
    expect((await read(adaToken))['appearance']).toBe('light');
    await act(async () => {
      release();
      await older;
    });
    await settle();
    expect((await read(adaToken))['appearance']).toBe('light');
  } finally {
    release();
    await older;
    await view.unmount();
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['themeFade'];
  }
});
