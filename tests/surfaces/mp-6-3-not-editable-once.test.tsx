// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 "not editable" said once (TA-02, D-19): the map's reading line says
// it and the legend does not repeat it. Read through the task page's real
// wiring: task.execution's bound plan beside task.read's gates.

import { describe, expect, it } from 'vitest';
import { openPage } from './mp-6-3-fixture.tsx';

describe('MP-6-3 not editable once', () => {
  it('MP-6-3 not editable once: the task page draws the bound plan and says "not editable" exactly once', async () => {
    const page = await openPage();
    expect(page.find('[data-execution-map="bound"]')).not.toBeNull();
    expect(
      page.all('[data-tg-node]').map((one) => (one as HTMLElement).dataset['tgNode']),
    ).toStrictEqual(['gather', 'terms', 'draft', 'send', 'file']);
    expect(page.text().match(/not editable/giu)?.length).toBe(1);
    expect(page.find('[data-map="reading"]')?.textContent).toContain('not editable');
    await page.unmount();
  });
});
