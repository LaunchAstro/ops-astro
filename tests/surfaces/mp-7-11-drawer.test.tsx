// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-7-11, the assistant drawer drawn (DOCK T-16, AI-01 to AI-12). The drawer
// decides nothing: each control hands the tab, title, model or question to its
// caller, whose path is the real conversation command. What these tests prove
// is what a person sees and what each press hands on, including the press that
// must hand on nothing: a question about a client's material.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantPanel } from '../../packages/ui/src/index.ts';
import {
  chat,
  doubleClick,
  drawer,
  heardOf,
  press,
  unmountAll,
} from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- the head and the tab row, each part drawn
describe('MP-7-11 drawer: head and tab row', () => {
  it('is labelled Agent, with the eye control, the model picker and the tab strip', async () => {
    const page = await drawer();
    const panel = page.find('[data-assistant="panel"]');
    expect(panel?.getAttribute('aria-label')).toBe('Agent');
    expect(page.find('.aip__title')?.textContent).toBe('Agent');
    expect(page.find('[data-assistant="add-page"]')?.getAttribute('title')).toBe(
      'Add page to context',
    );
    expect(page.find('[data-assistant="model"]')?.getAttribute('aria-label')).toBe(
      'Which model you are talking to',
    );
    expect(page.find('[role="tablist"]')?.getAttribute('aria-label')).toBe('Conversations');
  });

  it('MP-7-11 switch conversations', async () => {
    const page = await drawer();
    expect(page.find('[data-chat="1"]')?.getAttribute('aria-selected')).toBe('true');
    expect(page.find('[data-chat="2"]')?.getAttribute('aria-selected')).toBe('false');
    await page.click('[data-chat="2"]');
    expect(heardOf(page, 'select')).toStrictEqual([['2']]);
  });

  it('MP-7-11 arrow keys', async () => {
    const page = await drawer({ chats: [chat('1'), chat('2'), chat('3')], selected: '2' });
    // Roving focus: only the selected tab is in the tab order.
    expect(page.all('[data-chat]').map((tab) => tab.getAttribute('tabindex'))).toStrictEqual([
      '-1',
      '0',
      '-1',
    ]);
    await press(page, '[data-chat="2"]', 'ArrowRight');
    await press(page, '[data-chat="2"]', 'ArrowLeft');
    await press(page, '[data-chat="2"]', 'Home');
    await press(page, '[data-chat="2"]', 'End');
    expect(heardOf(page, 'select')).toStrictEqual([['3'], ['1'], ['1'], ['3']]);
    // It wraps at both ends.
    await page.render(<AssistantPanel {...page.props} selected="3" />);
    await press(page, '[data-chat="3"]', 'ArrowRight');
    expect(heardOf(page, 'select').at(-1)).toStrictEqual(['1']);
    expect(document.activeElement?.getAttribute('data-chat')).toBe('1');
  });

  it('MP-7-11 conversation tabs: double-click renames in place', async () => {
    const page = await drawer();
    expect(page.find('[data-chat="1"]')?.getAttribute('title')).toBe(
      'Chat 1 — double-click to rename',
    );
    await doubleClick(page, '[data-chat="1"]');
    const field = page.find('[data-chat-rename="1"]');
    expect(field?.getAttribute('maxlength')).toBe('40');
    await page.type('[data-chat-rename="1"]', 'Booking form');
    await press(page, '[data-chat-rename="1"]', 'Enter');
    expect(heardOf(page, 'rename')).toStrictEqual([['1', 'Booking form']]);
    expect(page.find('[data-chat-rename]')).toBeNull();

    // Escape reverts and hands on nothing.
    await doubleClick(page, '[data-chat="2"]');
    await page.type('[data-chat-rename="2"]', 'Thrown away');
    await press(page, '[data-chat-rename="2"]', 'Escape');
    expect(heardOf(page, 'rename')).toHaveLength(1);
    expect(page.find('[data-chat="2"]')?.textContent).toContain('Chat 2');
  });

  it('MP-7-11 take out of tab row, and a new one', async () => {
    const page = await drawer();
    expect(page.find('[data-chat-close="2"]')?.getAttribute('aria-label')).toBe('Close Chat 2');
    await page.click('[data-chat-close="2"]');
    await page.click('[data-assistant="new"]');
    expect(heardOf(page, 'takeOut')).toStrictEqual([['2']]);
    expect(heardOf(page, 'new')).toStrictEqual([[]]);
    expect(page.find('[data-assistant="new"]')?.getAttribute('aria-label')).toBe(
      'New conversation',
    );
  });

  it('MP-7-11 model per conversation', async () => {
    const page = await drawer({ chats: [chat('1', { model: 'claude-sonnet-5-5' })] });
    const picker = page.find('[data-assistant="model"]') as HTMLSelectElement | null;
    expect(picker?.value).toBe('claude-sonnet-5-5');
    await page.choose('[data-assistant="model"]', 'claude-opus-5-5');
    expect(heardOf(page, 'model')).toStrictEqual([['1', 'claude-opus-5-5']]);
  });

  it('MP-7-11 add page to context', async () => {
    const page = await drawer({
      chats: [
        chat('1', {
          page: { address: '/settings', shows: 'Settings' },
          messages: [
            {
              id: 'page',
              role: 'note',
              body: 'Read this page into context — every widget on /settings, and nothing else.',
              cites: [],
            },
          ],
        }),
      ],
    });
    await page.click('[data-assistant="add-page"]');
    expect(heardOf(page, 'addPage')).toStrictEqual([['1']]);
    expect(page.find('.aip__msg--note')?.textContent).toContain('every widget on /settings');
  });
});
