// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13 (DN-02, CS-4.37): a draft filed from a door opens with the page's
// guesses in its fields and the sentence that admits them, and Create writes
// the guessed category and owner on the new task, each by its own command.
// The guesses themselves are mp-4-13-prefill-from-the-page.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import type { DraftScope } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { NEW_ID, create, draft, server, store, valueOf } from './draft-support.tsx';

afterEach(unmountAll);

const NOW = new Date('2026-10-06T22:00:00Z');
const prefill = prefillOf(
  {
    from: 'Site health',
    subject: 'Checkout down',
    category: 'seo',
    clientId: 'c-client-a',
    owner: { id: 'p-len', name: 'Len' },
  },
  NOW,
);
const DOOR: DraftScope = { clientId: prefill.clientId, from: 'Site health', prefill };

describe('MP-4-13 a draft filed from a door opens with the page’s guesses', () => {
  it('the guessed category, estimate, due and owner are on the draft, with the admission sentence', async () => {
    const { view } = await draft({ scope: DOOR });
    expect(valueOf(view, '#panel-draft-category')).toBe('seo');
    expect(valueOf(view, '#panel-draft-estimate')).toBe('240');
    expect(valueOf(view, '#panel-draft-due')).toBe('2026-10-14');
    expect(view.host.querySelector('[data-draft-owner]')?.textContent).toContain('Len');
    expect(view.host.querySelector('[data-draft-admission]')?.textContent).toBe(
      'New task, filed from Site health. Guessed from “Checkout down”: due in 7 days; owner Len. Nothing is stored until Create.',
    );
  });
});

describe('MP-4-13 CS-4.37 Create writes the page’s guesses', () => {
  it('Create writes the guessed client, category and owner, each by its own command', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client, scope: DOOR });
    await typeInto(view, '#panel-draft-name', 'Fix checkout');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/set_category',
      '/task/assign',
    ]);
    expect(sent[0]?.body).toMatchObject({
      fields: { title: 'Fix checkout', due: '2026-10-14', estimated_minutes: 240 },
    });
    expect(sent[2]?.body).toMatchObject({ recordId: NEW_ID, fields: { category: 'seo' } });
    expect(sent[3]?.body).toMatchObject({ recordId: NEW_ID, fields: { assignee: 'p-len' } });
  });

  it('a category changed and the owner cleared on the draft are what Create writes', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client, scope: DOOR });
    await typeInto(view, '#panel-draft-name', 'Fix checkout');
    await view.choose('#panel-draft-category', 'content');
    await view.click('[data-draft="clear-owner"]');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/set_category',
    ]);
    expect(sent[2]?.body).toMatchObject({ fields: { category: 'content' } });
  });

  it('a kept draft comes back as left, whatever door reopens it (DN-04)', async () => {
    const storage = store();
    const first = await draft({ storage, scope: DOOR });
    await typeInto(first.view, '#panel-draft-name', 'Kept name');
    await first.view.unmount();
    const other = prefillOf({ from: 'Inbox', category: 'branding' }, NOW);
    const { view } = await draft({
      storage,
      scope: { clientId: null, from: 'Inbox', prefill: other },
    });
    expect(valueOf(view, '#panel-draft-name')).toBe('Kept name');
    expect(valueOf(view, '#panel-draft-category')).toBe('seo');
  });
});
