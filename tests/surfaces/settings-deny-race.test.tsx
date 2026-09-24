// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A save answered between a refused read's commit and its effect does not
// overwrite the refusal's mark (THERMO-RECHECK-3 R3C1, consequence b).
//
// The refusal is written to storage by an effect, which React runs after the
// commit, in a later task when the commit has used up its time slice. A write
// confirmed in that gap must not leave its value in the tab over the mark: a
// remount in the same session with an unavailable read would draw it.
//
// `act` flushes a commit and its effects together, so this file runs React on
// its own scheduler instead. A layout effect in a sibling sees the refused read
// committed, holds the thread past the slice so the effect waits for the next
// task, and answers the write, whose settlement then runs in the gap.

import { useLayoutEffect, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const ADA: Session = { token: 'tok-ada', businessKey: 'alpha', email: 'ada@alpha.local' };

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['settings:read'], fixes: [] };
const UNAVAILABLE = { unavailable: true, because: 'the API did not answer' };
const CAPABILITIES = {
  ok: true,
  value: {
    ok: true,
    personId: 'p',
    businessKey: 'alpha',
    grants: [{ collection: 'settings', action: 'manage' }],
  },
};
const CONFIRMED = { ok: true, value: { recordId: 'row', revision: null, detail: { value: 7777 } } };

/** A client whose first `settings.read` and whose write answer when released. */
function client(): {
  readonly client: OperationsClient;
  readonly releaseRead: () => void;
  readonly releaseWrite: () => void;
} {
  const gates = { read: (): void => {}, write: (): void => {} };
  const readHeld = new Promise<void>((resolve) => {
    gates.read = resolve;
  });
  const writeHeld = new Promise<void>((resolve) => {
    gates.write = resolve;
  });
  const first = { read: true };
  const fake = {
    businessKey: 'alpha',
    read: async (name: string) => {
      if (name !== 'settings.read') return CAPABILITIES;
      if (!first.read) return UNAVAILABLE;
      first.read = false;
      await readHeld;
      return DENIED;
    },
    mutate: async () => {
      await writeHeld;
      return CONFIRMED;
    },
  };
  return {
    client: fake as unknown as OperationsClient,
    releaseRead: () => {
      gates.read();
    },
    releaseWrite: () => {
      gates.write();
    },
  };
}

const outcome = (): string | null =>
  document.querySelector('[data-settings="read"]')?.getAttribute('data-outcome') ?? null;

const cached = (): string =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith('ops-astro.settings.'))
    .map((key) => window.sessionStorage.getItem(key) ?? '')
    .join('');

/** The screen, beside a probe that answers the write on the refusal's commit. */
function Harness(props: {
  readonly screen: ReactElement;
  readonly onDeniedCommit: () => void;
  readonly beat: (bump: () => void) => void;
}): ReactElement {
  const [, setBeat] = useState(0);
  props.beat(() => {
    setBeat((was) => was + 1);
  });
  return (
    <>
      {props.screen}
      <Probe onDeniedCommit={props.onDeniedCommit} />
    </>
  );
}

function Probe(props: { readonly onDeniedCommit: () => void }): null {
  useLayoutEffect(() => {
    if (outcome() === 'denied') props.onDeniedCommit();
  });
  return null;
}

const screenFor = (fake: OperationsClient): ReactElement => (
  <SettingsScreen client={fake} grantKey={grantKeyOf(ADA)} storage={window.sessionStorage} />
);

/** Wait for the DOM to say `done`, a macrotask at a time, for a second at most. */
const until = async (done: () => boolean, left = 100): Promise<void> => {
  if (done() || left === 0) {
    expect(done()).toBe(true);
    return;
  }
  await wait(10);
  await until(done, left - 1);
};

const field = (): HTMLInputElement | null => document.querySelector('#settings-four-eyes');
const button = (): HTMLButtonElement | null =>
  document.querySelector('[data-settings="save-four-eyes"]');

/** A fresh host in the document, for one root. */
const host = (): HTMLDivElement => {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
};

describe('a save answered between a refused read and its effect', () => {
  const roots: Root[] = [];
  beforeEach(() => {
    window.sessionStorage.clear();
    new SessionStore(window.sessionStorage).set(ADA);
  });
  afterEach(() => {
    for (const root of roots.splice(0)) root.unmount();
    document.body.replaceChildren();
  });

  it('leaves the deny mark, so a same-session remount with an unavailable read draws nothing', async () => {
    const api = client();
    const armed = { now: false, bump: (): void => {} };
    const first = host();
    const root = createRoot(first);
    roots.push(root);
    root.render(
      <Harness
        screen={screenFor(api.client)}
        beat={(bump) => {
          armed.bump = bump;
        }}
        onDeniedCommit={() => {
          if (!armed.now) return;
          armed.now = false;
          // Past the scheduler's slice, so the refusal's effect waits a task.
          const end = performance.now() + 15;
          while (performance.now() < end) {
            // Hold the thread.
          }
          api.releaseWrite();
        }}
      />,
    );
    await until(() => button()?.disabled === false);

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field(), '7777');
    field()?.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(10);
    button()?.click();
    await wait(10);

    // The read is refused in the same render as the probe's parent, so the
    // probe's layout effect runs in the commit that draws the refusal.
    armed.now = true;
    armed.bump();
    api.releaseRead();
    await until(() => outcome() === 'denied' && !armed.now);
    await wait(50);

    expect(cached()).toContain('"denied":true');
    expect(cached()).not.toContain('7777');

    root.unmount();
    roots.splice(0);
    first.remove();
    const again = host();
    const later = createRoot(again);
    roots.push(later);
    const unavailable = {
      businessKey: 'alpha',
      read: (name: string) =>
        Promise.resolve(name === 'settings.read' ? UNAVAILABLE : CAPABILITIES),
    } as unknown as OperationsClient;
    later.render(screenFor(unavailable));
    await until(() => outcome() === 'unavailable');
    expect(again.textContent).not.toContain('7777');
  });
});
