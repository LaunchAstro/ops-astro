// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-7-11, the drawer's asking half: chips, the input, the ask seam's citation,
// answers citing what they read, a failed reply, and a client's question that
// must send nothing while its material waits on a local model.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
// Not exported from the package until its first host page mounts it.
import { AskSparkle } from '../../packages/ui/src/surfaces/assistant/asker.tsx';
import { mount } from './mount.tsx';
import { chat, drawer, heardOf, press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- the asking half, each part drawn
describe('MP-7-11 drawer: asking', () => {
  it('MP-7-11 suggestion chips and MP-7-11 suggested question', async () => {
    const page = await drawer();
    expect(page.all('.aip__chip').map((chip) => chip.textContent)).toStrictEqual([
      "What's going on here?",
      'What should I look at first?',
    ]);
    await page.click('.aip__chip');
    expect(heardOf(page, 'send')).toStrictEqual([['1', "What's going on here?"]]);
  });

  it('asks from the input; Enter sends, an empty input does nothing', async () => {
    const page = await drawer();
    expect(page.find('[data-assistant="input"]')?.getAttribute('placeholder')).toBe(
      'Ask about this page…',
    );
    await page.click('[data-assistant="send"]');
    await page.type('[data-assistant="input"]', '   ');
    await press(page, '[data-assistant="input"]', 'Enter');
    expect(heardOf(page, 'send')).toStrictEqual([]);
    await page.type('[data-assistant="input"]', 'What does this setting do?');
    await press(page, '[data-assistant="input"]', 'Enter');
    expect(heardOf(page, 'send')).toStrictEqual([['1', 'What does this setting do?']]);
    expect((page.find('[data-assistant="input"]') as HTMLInputElement).value).toBe('');
  });

  it('MP-7-11 local model needed in plain words: a client question sends nothing', async () => {
    const page = await drawer({
      subject: { label: 'Meridian Physio', placeholder: 'Ask about this client…', chips: ['Why?'] },
      offer: {
        models: [],
        waiting:
          'This client’s material waits on a local model, so nothing is sent to a cloud model.',
      },
    });
    expect(page.all('[data-assistant="model"] option')).toHaveLength(0);
    expect(page.find('[data-assistant="model"]')?.hasAttribute('disabled')).toBe(true);
    expect(page.find('[data-assistant="local-model"]')?.textContent).toContain(
      'waits on a local model',
    );
    await page.type('[data-assistant="input"]', 'How is Meridian going?');
    await press(page, '[data-assistant="input"]', 'Enter');
    await page.click('[data-assistant="send"]');
    await page.click('.aip__chip');
    expect(heardOf(page, 'send')).toStrictEqual([]);
    expect(page.find('[data-assistant="not-sent"]')?.textContent).toBe(
      'Nothing was sent: this client’s material waits on a local model.',
    );
  });

  it('MP-7-11 widget cited: the drafted question and the citation are shown', async () => {
    const page = await drawer({
      citation: { row: 'CL-M03', id: 'clients-row-meridian', label: 'Meridian Physio, Clients' },
      draft: 'What changed for Meridian this week?',
    });
    expect(page.find('[data-assistant="citation"]')?.textContent).toBe(
      'Asked from Meridian Physio, Clients',
    );
    expect((page.find('[data-assistant="input"]') as HTMLInputElement).value).toBe(
      'What changed for Meridian this week?',
    );
  });

  it('MP-7-11 answer cites what it read: each record is a link, and only an own address', async () => {
    const page = await drawer({
      chats: [
        chat('1', {
          messages: [
            { id: 'q', role: 'user', body: 'Where is the form?', cites: [] },
            {
              id: 'a',
              role: 'ai',
              body: 'On the booking task.',
              cites: [
                { label: 'Fix the booking form', href: '/task/T-12' },
                { label: 'Hostile', href: 'https://elsewhere.example/steal' },
                { label: 'Scheme', href: 'javascript:alert(1)' },
                { label: 'Protocol-relative', href: '//elsewhere.example' },
              ],
            },
          ],
        }),
      ],
    });
    const cites = page.all('.aip__msg--ai [data-cites] li');
    expect(cites.map((item) => item.textContent)).toStrictEqual([
      'Fix the booking form',
      'Hostile',
      'Scheme',
      'Protocol-relative',
    ]);
    expect(
      page.all('.aip__msg--ai [data-cites] a').map((link) => link.getAttribute('href')),
    ).toStrictEqual(['/task/T-12']);
    expect(page.find('.aip__msg--user [data-cites]')).toBeNull();
  });

  it('a failed reply is shown as failed, with its words as text', async () => {
    const page = await drawer({
      chats: [
        chat('1', {
          messages: [
            { id: 'a', role: 'failed', body: '<b>The reply could not be read.</b>', cites: [] },
          ],
        }),
      ],
    });
    expect(page.find('[data-message-role="failed"]')?.textContent).toBe(
      '<b>The reply could not be read.</b>',
    );
    expect(page.find('[data-message-role="failed"] b')).toBeNull();
  });

  it('closes the panel', async () => {
    const page = await drawer();
    expect(page.find('[data-assistant="close"]')?.getAttribute('aria-label')).toBe(
      'Close the panel',
    );
    await page.click('[data-assistant="close"]');
    expect(heardOf(page, 'close')).toStrictEqual([[]]);
  });
});

describe('MP-7-11 gesture law', () => {
  it('the sparkle hands its entry and the shift key to the host, and opens nothing itself', async () => {
    const heard: unknown[] = [];
    const page = await mount(
      <AskSparkle
        row="CL-M03"
        widget="Meridian Physio, Clients"
        onAsk={(shift) => heard.push(shift)}
      />,
    );
    track(page);
    const sparkle = page.find('[data-ask="CL-M03"]');
    expect(sparkle?.getAttribute('aria-label')).toBe(
      'Ask the agent about Meridian Physio, Clients',
    );
    await page.click('[data-ask="CL-M03"]');
    await act(() => {
      sparkle?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(heard).toStrictEqual([false, true]);
    expect(document.querySelector('[data-assistant="panel"]')).toBeNull();
  });
});
