// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-3 (batch 2c1 review): an unsaved edit is resolved, not merged
// (tests/surfaces/task-detail-drafts). While a title or due date is unsaved,
// the assignee and the lifecycle are held until Save or Discard; Assign to AI
// is an assignment too, and a landed one rereads the task under the unsaved
// edit, so it must be held the same way.

import { afterEach, describe, expect, it } from 'vitest';
import { found, page } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const MINE = [
  { delegationId: 'd-mine-1', purpose: 'draft_replies' },
  { delegationId: 'd-mine-2', purpose: 'triage_inbox' },
];

const disabledOf = (host: HTMLElement, selector: string): boolean => {
  const control = host.querySelector(selector) as HTMLSelectElement | null;
  if (control === null) throw new Error(`nothing matches ${selector}`);
  return control.disabled;
};

describe('REVIEW-2C1-3 Assign to AI held by an unsaved edit', () => {
  it('REVIEW-2C1-3: with an unsaved title, Assign to AI is disabled like Refresh, the assignee and the lifecycle', async () => {
    const view = await page('Proj-Verity-Pacing', found({ myAgents: MINE }));
    // Clean: the control is there and open.
    expect(disabledOf(view.host, '#page-assign-ai')).toBe(false);

    await view.type('#task-title', 'A title nobody has saved yet');

    // Dirty: the choice is on screen and the paths that reread are shut.
    expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();
    expect(disabledOf(view.host, 'button[data-refresh="task"]')).toBe(true);
    expect(
      disabledOf(view.host, '#page-assign-ai'),
      'Assign to AI stays open while the title edit is unsaved',
    ).toBe(true);
  });
});
