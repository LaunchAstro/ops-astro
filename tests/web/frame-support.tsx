// SPDX-License-Identifier: AGPL-3.0-only
//
// What the app-frame tests (U06, U07) share: jsdom lays nothing out, so every
// element's offset is zero and a mark that follows the current item cannot be
// seen to move. `layout()` gives each element a box from its place among its
// siblings, 36 tall and 120 wide, the way the rail and the tab row stack them,
// and hands back the undo. Real geometry is measured in a browser by
// `tests/browser/app-frame.mjs`.

import { act } from 'react';
import type { Mounted } from '../surfaces/mount.tsx';

export const ITEM_HEIGHT = 36;
export const TAB_WIDTH = 120;

const place = (element: Element): number =>
  element.parentElement === null ? 0 : [...element.parentElement.children].indexOf(element);

export function layout(): () => void {
  const saved = (['offsetTop', 'offsetHeight', 'offsetLeft', 'offsetWidth'] as const).map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const,
  );
  Object.defineProperties(HTMLElement.prototype, {
    offsetTop: {
      configurable: true,
      get(this: HTMLElement) {
        return place(this) * ITEM_HEIGHT;
      },
    },
    offsetHeight: { configurable: true, get: () => ITEM_HEIGHT },
    offsetLeft: {
      configurable: true,
      get(this: HTMLElement) {
        return place(this) * TAB_WIDTH;
      },
    },
    offsetWidth: { configurable: true, get: () => TAB_WIDTH },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
  };
}

/** A person's click on a link: a real bubbling event the application may take over. */
export async function follow(view: Mounted, selector: string): Promise<MouseEvent> {
  const [target] = view.all(selector);
  if (target === undefined) throw new Error(`nothing matches ${selector}`);
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

export async function press(
  target: EventTarget,
  key: string,
  options: {
    readonly shiftKey?: boolean;
    readonly metaKey?: boolean;
    readonly ctrlKey?: boolean;
  } = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
  });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** The label of the one lit rail item. */
export const lit = (view: Mounted): readonly string[] =>
  view.all('.rail [data-lit]').map((item) => item.textContent?.trim() ?? '');
