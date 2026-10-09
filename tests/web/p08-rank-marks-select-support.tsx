// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';

export interface HouseOption {
  readonly value: string;
  readonly text: string;
  readonly disabled: boolean;
  readonly selected: boolean;
}

async function openMenu(trigger: HTMLButtonElement | null): Promise<HTMLElement> {
  if (trigger === null || trigger.getAttribute('aria-haspopup') !== 'listbox') {
    throw new Error('Expected a house Select trigger');
  }
  if (trigger.disabled) throw new Error(`Select ${trigger.id} is disabled`);
  await act(() => trigger.click());
  const menuId = trigger.getAttribute('aria-controls');
  const menu =
    menuId === null ? null : trigger.ownerDocument.querySelector<HTMLElement>(`[id="${menuId}"]`);
  if (
    trigger.getAttribute('aria-expanded') !== 'true' ||
    menu === null ||
    menu.getAttribute('role') !== 'listbox' ||
    menu.getAttribute('aria-labelledby') !== trigger.id
  ) {
    throw new Error(`Select ${trigger.id} did not open its controlled listbox`);
  }
  return menu;
}

async function closeMenu(trigger: HTMLButtonElement): Promise<void> {
  await act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  if (trigger.getAttribute('aria-expanded') !== 'false') {
    throw new Error(`Escape did not close Select ${trigger.id}`);
  }
}

/** Read the choices a person can open, then dismiss without choosing. */
export async function houseOptions(
  trigger: HTMLButtonElement | null,
): Promise<readonly HouseOption[]> {
  const menu = await openMenu(trigger);
  try {
    return [...menu.querySelectorAll('[role="option"]')].map((option) => {
      const text = option.textContent ?? '';
      const value = text === 'Not set' ? '' : text;
      return {
        value,
        text: option.textContent ?? '',
        disabled: option.getAttribute('aria-disabled') === 'true',
        selected: option.getAttribute('aria-selected') === 'true',
      };
    });
  } finally {
    if (trigger !== null) await closeMenu(trigger);
  }
}

/** Choose through the trigger's actual listbox, never through a synthetic change. */
export async function chooseHouse(trigger: HTMLButtonElement, value: string): Promise<void> {
  const menu = await openMenu(trigger);
  try {
    const option = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (choice) => choice.textContent === (value === '' ? 'Not set' : value),
    );
    if (option === undefined) throw new Error(`Select ${trigger.id} has no option ${value}`);
    if (option.getAttribute('aria-disabled') === 'true') {
      throw new Error(`Select ${trigger.id} option ${value} is disabled`);
    }
    await act(() => option.click());
  } finally {
    if (trigger.getAttribute('aria-expanded') === 'true') await closeMenu(trigger);
  }
}
