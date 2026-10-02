// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-24: the staged output's header says "built · nothing published"
// whatever happened (`packages/ui/src/surfaces/agent/staged.tsx`). Once the
// version's evidence says it shipped, the header says it is live, and must
// not also say nothing was published.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

describe('REVIEW-3A-24 the staged header once shipped', () => {
  it('REVIEW-3A-24: with shipped evidence the staged header does not say "nothing published"', async () => {
    const shipped = { at: '2026-09-29', artefact: 'v1', snapshot: 'snap-1', rolledBackAt: null };
    const page = await pane({
      lineages: [
        lineage({
          state: 'completed',
          versions: [version({ evidence: { digest: 'e', body: { shipped } } })],
        }),
      ],
    });
    // The shipped evidence was read: the box and the header's live word are drawn.
    expect(page.find('[data-agent="shipped"]')).not.toBeNull();
    const header = page.find('[data-agent="staged"] .sb__sh')?.textContent ?? '';
    expect(header).toContain('Live · since 2026-09-29');
    expect(header, 'a shipped version is published').not.toContain('nothing published');
  });
});
