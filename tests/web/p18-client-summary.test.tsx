// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { found, page } from './task-page-stub.tsx';

describe('P18 guarded client facts on the task page', () => {
  it.each([
    [{ kind: 'readable', name: 'Verity' }, true, 'Verity'],
    [{ kind: 'readable', name: '' }, true, 'Client without a name'],
    [{ kind: 'none' }, false, 'not set'],
    [{ kind: 'withheld' }, true, 'A client you cannot see'],
    [undefined, true, 'Client details unavailable'],
    [undefined, false, 'Client details unavailable'],
  ])(
    'draws the served client summary %j without inventing a name',
    async (clientSummary, clientSet, words) => {
      const view = await page('Proj-Verity-Pacing', found({ clientSummary, clientSet }));
      expect(view.find('[data-field="client"] dd')?.textContent).toBe(words);
      expect(view.all('[data-band] dt')).toHaveLength(10);
      await view.unmount();
    },
  );
});
