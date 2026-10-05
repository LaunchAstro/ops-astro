// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable consistent-function-scoping, max-lines-per-function, no-await-in-loop, no-loop-func, no-promise-executor-return, no-useless-spread -- Sol's proof, kept as written */
import { act, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useSavedFlag } from '../../apps/web/src/screens/task/saved-flag.ts';
import { createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';
import { mount, unmountAll } from './perspective-support.tsx';

let fixture: ApiFixture;
let token: string;
beforeAll(async () => {
  fixture = await createApiFixture('solow095flag');
  token = await tokenFor(fixture.member.presented.subject);
});
afterEach(unmountAll);
afterAll(async () => {
  await fixture?.drop();
});

function deferred() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function Fold({
  client,
  name,
}: {
  readonly client: OperationsClient;
  readonly name: string;
}): ReactElement {
  const [open, choose] = useSavedFlag(client, name);
  return (
    <button type="button" data-fold aria-expanded={open} onClick={() => choose(!open)}>
      Fold
    </button>
  );
}

// Sol OW-095.3 criterion 5, retitled by what it proves; its body is Sol's.
for (const name of ['subtasks.showFinished', 'history.showTrail']) {
  it(`${name} keeps the latest click when an earlier save reaches the server last`, async () => {
    const api = fixture.compose();
    const readReady = deferred();
    const gate = deferred();
    const secondSaved = deferred();
    const pending = new Set<Promise<Response>>();
    let saves = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const path = String(input);
      const ordinal = path.endsWith('/preference/save') ? ++saves : 0;
      const request = (async () => {
        if (ordinal === 1) await gate.promise;
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${token}`);
        const response = await api.fetch(
          new Request(`http://api.test${path}`, { ...init, headers }),
        );
        expect(response.status).toBe(200);
        if (ordinal === 2) secondSaved.release();
        if (path.endsWith('/preference/read')) readReady.release();
        return response;
      })();
      pending.add(request);
      void request.then(() => pending.delete(request));
      return request;
    };
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const view = await mount(<Fold client={client} name={name} />);
    await act(async () => {
      await readReady.promise;
    });
    await view.click('[data-fold]');
    await view.click('[data-fold]');
    expect(view.find('[data-fold]')?.getAttribute('aria-expanded')).toBe('false');
    try {
      // A serial implementation will withhold save 2 until save 1 finishes.
      await Promise.race([
        secondSaved.promise,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
    } finally {
      await act(async () => {
        gate.release();
        while (pending.size > 0) await Promise.all([...pending]);
      });
    }
    const stored = await client.read<{ preferences: Record<string, unknown> }>(
      'preference.read',
      {},
    );
    expect('value' in stored).toBe(true);
    if (!('value' in stored)) throw new Error('The final preference read was refused.');
    expect(
      stored.value.preferences[name],
      'The earlier true save overwrote the latest false click.',
    ).toBe(false);
  });
}
