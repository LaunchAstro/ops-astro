// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's side column on the Agent pane (the mockup's S6 layout, `.tpg`):
// the run itself in the main column, and the granted scope and the token
// panel in a side column after it, 21rem wide beside main at 1279 and above
// and stacked under it below. jsdom lays nothing out, so the width rule is
// read from the stylesheet the pane ships with; the visual match at 1480, 900
// and 390 is MP-1-7's harness.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const STYLES = 'packages/ui/src/styles/6-agent.css';

describe('MP-6-2 side column', () => {
  it('MP-6-2 side column: the granted scope and the token panel sit in a side column after the main one, and the run stays in main', async () => {
    const page = await pane({ ledger: { envelopes: [] }, lineages: [lineage()] });
    const main = page.find('[data-agent="main"]');
    const side = page.find('[data-agent="side"]');
    expect(main).not.toBeNull();
    expect(side?.tagName).toBe('ASIDE');
    expect(side?.querySelector('[data-agent="scope"]')).not.toBeNull();
    expect(side?.querySelector('[data-agent="tokens"]')).not.toBeNull();
    expect(main?.querySelector('[data-agent="scope"], [data-agent="tokens"]')).toBeNull();
    expect(main?.querySelector('[data-agent="summary"]')).not.toBeNull();
    expect(main?.querySelector('[data-agent="gate"]')).not.toBeNull();
    const order = main?.compareDocumentPosition(side as Node) ?? 0;
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('MP-6-2 side column: 21rem beside main at 1279 and above, stacked under it below', () => {
    const css = readFileSync(STYLES, 'utf8');
    const base = /^\.tpg \{([^}]*)\}/mu.exec(css)?.[1] ?? '';
    expect(base).toContain('display: grid');
    expect(base).not.toContain('grid-template-columns');
    expect(css).toMatch(
      /@media \(width >= 1279px\) \{\s*\.tpg \{\s*grid-template-columns: minmax\(0, 1fr\) 21rem;/u,
    );
  });
});
