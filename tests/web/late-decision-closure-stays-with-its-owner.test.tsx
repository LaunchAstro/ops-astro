// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A decision settles on the callbacks drawn when it was pressed, so a refusal
// can land after the business or person changed, after the other view was
// refused, or for another task. Each view here holds its own note as the task
// page and the dock panel do (`useHeld` with `keepsClosure`), shares it
// through `useSharedNote`, and settles through the gate's own `settled`.

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { WireRefusal } from '../../apps/web/src/operations/client.ts';
import type { Settlement } from '../../apps/web/src/records/use-command.ts';
import { useHeld } from '../../apps/web/src/screens/task/held-state.ts';
import {
  DecisionClosures,
  useForgetOnDenial,
  useSharedNote,
} from '../../apps/web/src/views/decision-closures.tsx';
import {
  keepsClosure,
  settled,
  type DecisionNote,
} from '../../apps/web/src/views/gate-controls.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

type Decided = (note: DecisionNote | null) => void;

/** Each view's `onDecided` as last drawn, which is what a press captures. */
const drawn = new Map<string, Decided>();
const pages: Mounted[] = [];
afterEach(async () => {
  drawn.clear();
  await Promise.all(pages.splice(0).map((page) => page.unmount()));
});

interface ViewProps {
  readonly name: string;
  readonly owner: string;
  readonly taskId: string;
  readonly denied?: boolean;
}

/** One view of one task, holding its own note above its read. */
function View(props: ViewProps): ReactElement {
  const [own, setOwn] = useHeld<DecisionNote>(
    `${props.owner}\u0000${props.taskId}`,
    props.denied === true,
    keepsClosure,
  );
  useForgetOnDenial(props.taskId, props.denied === true);
  const shared = useSharedNote({ id: props.taskId, key: props.taskId }, own, setOwn);
  drawn.set(props.name, shared.onDecided);
  return <i data-view={props.name} data-closed={String(shared.note?.closed === true)} />;
}

const frame = (owner: string, views: readonly Omit<ViewProps, 'owner'>[]): ReactElement => (
  <DecisionClosures owner={owner}>
    {views.map((each) => (
      <View key={each.name} owner={owner} {...each} />
    ))}
  </DecisionClosures>
);

const refusal = (names: readonly string[] = []): Settlement => ({
  kind: 'closed',
  refusal: { refused: true, code: 'SCOPE_NOT_GRANTED', names, fixes: [] } as unknown as WireRefusal,
  because: 'Not granted.',
});

/** The reread every settlement asks for, which these views do not draw. */
const reread = (): void => {
  /* each view's read is not under test */
};

/** Settle a decision on the callback a press captured, as the gate's controls do. */
async function land(decided: Decided, settlement: Settlement): Promise<void> {
  await act(() => {
    settled(settlement, {
      onDecided: decided,
      onChanged: reread,
      lineageId: 'l-1',
      gate: { id: 'g-1' },
    });
  });
}

const closed = (page: Mounted, name: string): string | undefined =>
  (page.find(`[data-view="${name}"]`) as HTMLElement | null)?.dataset['closed'];

const both = (taskId: string) => [
  { name: 'page', taskId },
  { name: 'panel', taskId },
];

async function opened(owner: string, views: readonly Omit<ViewProps, 'owner'>[]) {
  const page = await mount(frame(owner, views));
  pages.push(page);
  return page;
}

const pressed = (name: string): Decided => {
  const decided = drawn.get(name);
  if (decided === undefined) throw new Error(`no view named ${name}`);
  return decided;
};

it('a refusal that lands after a switch closes nothing under the new owner, nor after switching back', async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  const late = pressed('page');
  await page.render(frame('bravo:bea@bravo.local:1', both('task-1')));
  await land(late, refusal());
  expect(closed(page, 'page')).toBe('false');
  expect(closed(page, 'panel')).toBe('false');
  await page.render(frame('alpha:mia@alpha.local:2', both('task-1')));
  expect(closed(page, 'page')).toBe('false');
  expect(closed(page, 'panel')).toBe('false');
});

it("a refusal that lands after a switch leaves the new owner's own closures in place", async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  const late = pressed('page');
  await page.render(frame('bravo:bea@bravo.local:1', both('task-2')));
  await land(pressed('panel'), refusal());
  expect(closed(page, 'page'), 'the panel closure closes the page under bravo').toBe('true');
  await land(late, refusal());
  expect(
    closed(page, 'page'),
    "alpha's late refusal must not drop bravo's closure from the page",
  ).toBe('true');
});

it('a closure of one task leaves another open task open', async () => {
  const page = await opened('alpha:mia@alpha.local:0', [
    { name: 'page', taskId: 'task-1' },
    { name: 'panel', taskId: 'task-2' },
  ]);
  await land(pressed('page'), refusal());
  expect(closed(page, 'page')).toBe('true');
  expect(closed(page, 'panel')).toBe('false');
});

it('an escalation refused for its recipient closes neither view', async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  await land(pressed('panel'), refusal(['recipientPersonId']));
  expect(closed(page, 'panel')).toBe('false');
  expect(closed(page, 'page')).toBe('false');
});

it('an older decision that succeeds after the other view was refused leaves both closed', async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  const older = pressed('page');
  await land(pressed('panel'), refusal());
  await land(older, { kind: 'ok', value: {} });
  expect(closed(page, 'page')).toBe('true');
  expect(closed(page, 'panel')).toBe('true');
});

it('a reread that answers unavailable keeps the closure in both views', async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  await land(pressed('page'), refusal());
  // Unavailable is not denied: each view keeps its note above the read.
  await page.render(frame('alpha:mia@alpha.local:0', both('task-1')));
  expect(closed(page, 'page')).toBe('true');
  expect(closed(page, 'panel')).toBe('true');
});

it("a read denied after a closure drops it from both views, as each view's own note is dropped", async () => {
  const page = await opened('alpha:mia@alpha.local:0', both('task-1'));
  await land(pressed('page'), refusal());
  await page.render(
    frame('alpha:mia@alpha.local:0', [
      { name: 'page', taskId: 'task-1', denied: true },
      { name: 'panel', taskId: 'task-1', denied: true },
    ]),
  );
  await page.render(frame('alpha:mia@alpha.local:0', both('task-1')));
  expect(
    closed(page, 'page'),
    'a denied read drops the page note, and the shared closure must not bring it back',
  ).toBe('false');
  expect(closed(page, 'panel')).toBe('false');
});
