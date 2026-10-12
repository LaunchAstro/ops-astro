// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A decision closure shared between the views of a task belongs to the
// business and person that were refused. After a switch of either, the same
// task id draws no closure, and switching back does not bring it back.

import type { ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { DecisionClosures, useSharedNote } from '../../apps/web/src/views/decision-closures.tsx';
import type { DecisionNote } from '../../apps/web/src/views/gate-controls.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const TASK = 'task-1';
const CLOSED: DecisionNote = {
  because: 'Not yours.',
  closed: true,
  gateId: 'g-1',
  lineageId: 'l-1',
};
const pages: Mounted[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.unmount()));
});

const ignore = (): void => {
  /* each view's own note is not under test */
};

/** One view of the task: it can be refused, and it says whether it is closed. */
function View(props: { readonly name: string }): ReactElement {
  const shared = useSharedNote(TASK, null, ignore);
  return (
    <button
      data-view={props.name}
      data-closed={String(shared.note?.closed === true)}
      onClick={() => {
        shared.onDecided(CLOSED);
      }}
    />
  );
}

const frame = (owner: string): ReactElement => (
  <DecisionClosures owner={owner}>
    <View name="page" />
    <View name="panel" />
  </DecisionClosures>
);

const closed = (page: Mounted, name: string): string | null | undefined =>
  (page.find(`[data-view="${name}"]`) as HTMLElement | null)?.dataset['closed'];

it('a closure in one view closes the other view of the same task', async () => {
  const page = await mount(frame('alpha:mia'));
  pages.push(page);
  await page.click('[data-view="panel"]');
  expect(closed(page, 'page')).toBe('true');
});

it.each(['bravo:mia', 'alpha:noah'])(
  'a switch to %s draws no closure, then or back',
  async (next) => {
    const page = await mount(frame('alpha:mia'));
    pages.push(page);
    await page.click('[data-view="panel"]');
    await page.render(frame(next));
    expect(closed(page, 'page')).toBe('false');
    expect(closed(page, 'panel')).toBe('false');
    await page.render(frame('alpha:mia'));
    expect(closed(page, 'page')).toBe('false');
  },
);
