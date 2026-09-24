// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The mounted application in a tab whose `sessionStorage` throws (thermo O9).
//
// Blocked site data makes the `sessionStorage` global throw on access, not
// merely on use. `main.tsx` guards it for the session store; the screens'
// storage must be read the same guarded way, or opening `/settings` in such a
// tab takes the whole application down instead of drawing "not known".

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount } from './mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

afterEach(() => {
  if (original !== undefined) Object.defineProperty(globalThis, 'sessionStorage', original);
});

describe('a tab whose sessionStorage throws', () => {
  it('still draws /settings', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const fetch = (() =>
      new Promise<Response>(() => {
        /* Held open: the screen stays on loading. */
      })) as unknown as typeof globalThis.fetch;
    const view = await mount(
      <App
        path="/settings"
        navigate={() => {
          /* The test drives the address directly. */
        }}
        sessions={new SessionStore(memory())}
        gotrueUrl="http://identity.invalid"
        apiBase="/api"
        fetch={fetch}
      />,
    );
    expect(view.find('[data-settings="capabilities"]')).not.toBeNull();
    await view.unmount();
  });
});
