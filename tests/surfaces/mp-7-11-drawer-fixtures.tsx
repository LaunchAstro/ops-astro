// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11, the drawer mounted over plain props, and the presses a person makes
// on it. Each handler the drawer is given records what it was handed, so a test
// reads exactly what a press hands on, including a press that hands on nothing.

import { act } from 'react';
import {
  AssistantPanel,
  type AssistantChat,
  type AssistantPanelProps,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

const live: Mounted[] = [];

export async function unmountAll(): Promise<void> {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
}

export function track(page: Mounted): Mounted {
  live.push(page);
  return page;
}

export interface Heard {
  readonly calls: (readonly unknown[])[];
}

export const chat = (id: string, overrides: Partial<AssistantChat> = {}): AssistantChat => ({
  key: id,
  title: `Chat ${id}`,
  model: null,
  page: null,
  messages: [],
  ...overrides,
});

export async function drawer(
  overrides: Partial<AssistantPanelProps> = {},
): Promise<Mounted & { readonly heard: Heard; readonly props: AssistantPanelProps }> {
  const heard: Heard = { calls: [] };
  const note =
    (name: string) =>
    (...args: readonly unknown[]): void => {
      heard.calls.push([name, ...args]);
    };
  const props: AssistantPanelProps = {
    subject: {
      label: 'Settings',
      placeholder: 'Ask about this page…',
      chips: ["What's going on here?", 'What should I look at first?'],
    },
    chats: [chat('1'), chat('2')],
    selected: '1',
    offer: {
      models: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5' },
        { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      ],
      waiting: null,
    },
    citation: null,
    draft: '',
    onSelect: note('select'),
    onRename: note('rename'),
    onTakeOut: note('takeOut'),
    onNew: note('new'),
    onModel: note('model'),
    onAddPage: note('addPage'),
    onSend: note('send'),
    onClose: note('close'),
    ...overrides,
  };
  const page = await mount(<AssistantPanel {...props} />);
  track(page);
  return Object.assign(page, { heard, props });
}

export const heardOf = (page: { readonly heard: Heard }, name: string): (readonly unknown[])[] =>
  page.heard.calls.filter((call) => call[0] === name).map((call) => call.slice(1));

export async function press(page: Mounted, selector: string, keyName: string): Promise<void> {
  const target = page.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

export async function doubleClick(page: Mounted, selector: string): Promise<void> {
  const target = page.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
}
