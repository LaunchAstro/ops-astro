// SPDX-License-Identifier: AGPL-3.0-only
//
// The smallest mount helper the two DOM tests need.
//
// No testing library is added for this. Both tests want three things — put a
// component in a real document, flush React's work, read the resulting DOM —
// and `createRoot` plus React 19's own `act` is all three. A query helper
// estate would be more code than the tests it serves.

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React only enables `act` when it is told it is in a test. Without this every
// flush warns and the warning is the only sign the flush did not happen.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  readonly host: HTMLElement;
  /** Re-render with new children, flushed. */
  readonly render: (element: ReactElement) => Promise<void>;
  readonly unmount: () => Promise<void>;
  /** Everything the document says, for the assertions about what is absent. */
  readonly text: () => string;
  readonly find: (selector: string) => Element | null;
  readonly all: (selector: string) => readonly Element[];
  /** Click, flushed. */
  readonly click: (selector: string) => Promise<void>;
  /** Type into a control the way a person does, so React sees the change. */
  readonly type: (selector: string, value: string) => Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });

  const mounted: Mounted = {
    host,
    render: async (next) => {
      await act(async () => {
        root?.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      host.remove();
    },
    text: () => host.textContent ?? '',
    find: (selector) => host.querySelector(selector),
    all: (selector) => [...host.querySelectorAll(selector)],
    click: async (selector) => {
      const target = host.querySelector(selector);
      if (target === null) throw new Error(`nothing matches ${selector}`);
      await act(async () => {
        (target as HTMLElement).click();
      });
    },
    type: async (selector, value) => {
      const target = host.querySelector(selector);
      if (target === null) throw new Error(`nothing matches ${selector}`);
      // React installs its own value setter on the element, so assigning
      // `.value` directly is invisible to it. The prototype setter plus a
      // bubbling `input` event is what a keystroke actually looks like.
      const field = target as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      await act(async () => {
        setter?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
  };
  return mounted;
}

/** Let every queued microtask and React effect settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
