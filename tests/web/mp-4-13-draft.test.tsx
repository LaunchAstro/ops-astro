// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13's new-task draft in the dock task panel (CS-4.36, CS-4.37; DN-01,
// DN-03 to DN-05; DP-02): the head's New task opens a draft, the draft is
// kept for its person until Create or Cancel, and Create writes a real task
// and then everything added on the draft through each one's own command, so
// each is audited under its own name. Closing the panel, or opening another
// task in it, while this person's timer runs stops and logs it (TR-S-PI6-4).
//
// The commands themselves (their rules, refusals, audit and isolation) are
// the server suites for `task.create`, `task.set_party`, the tag commands,
// `time.log` and `task.comment`; these prove what the draft sends.
//
// This suite: the door, the name, and the draft kept per person; Create and
// the timer are mp-4-13-create.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { PanelWithDoor, create, draft, fill, server, store, valueOf } from './draft-support.tsx';

afterEach(unmountAll);

describe('MP-4-13 the head’s New task opens a draft', () => {
  it('the dock task panel’s New task is a live door that asks the host for a draft', async () => {
    const asked = { count: 0 };
    const view = await mount(
      <PanelWithDoor
        onNewTask={() => {
          asked.count += 1;
        }}
      />,
    );
    await tick();
    const door = view.find('[data-panel-head="new"]') as HTMLButtonElement;
    expect(door.disabled).toBe(false);
    await view.click('[data-panel-head="new"]');
    expect(asked.count).toBe(1);
  });

  it('the draft says where it was filed from, and nothing is stored until Create', async () => {
    const { view } = await draft();
    expect(view.find('[data-draft-admission]')?.textContent).toBe(
      'New task, filed from Budget pacing fix. Nothing is stored until Create.',
    );
    expect(document.activeElement?.id).toBe('panel-draft-name');
  });
});

describe('MP-4-13 CS-4.36 name the new task', () => {
  it('an empty name is refused with the field focused, and nothing is sent', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', '   ');
    (view.find('[data-draft="create"]') as HTMLElement).focus();
    await create(view);
    expect(sent).toStrictEqual([]);
    expect(document.activeElement?.id).toBe('panel-draft-name');
    expect(view.find('[data-draft-refusal]')?.textContent).toBe('Name the new task first.');
  });

  it('not audited: typing on the draft sends nothing', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await fill(view);
    expect(sent).toStrictEqual([]);
  });
});

describe('MP-4-13 draft kept until create or cancel', () => {
  it('X, Escape and a reload keep the draft as left; reopening New task brings it back', async () => {
    const storage = store();
    const first = await draft({ storage });
    await fill(first.view);
    await press(first.view, '[data-draft-panel]', 'Escape');
    expect(first.outcome.closed).toBe(1);
    await first.view.click('[data-draft="close"]');
    expect(first.outcome.closed).toBe(2);
    await first.view.unmount();
    const again = await draft({ storage });
    expect(valueOf(again.view, '#panel-draft-name')).toBe('New brief');
    expect(valueOf(again.view, '#panel-draft-due')).toBe('2026-10-09');
    expect(valueOf(again.view, '#panel-draft-estimate')).toBe('60');
    expect(
      again.view.all('[data-draft-tag]').map((chip) => (chip as HTMLElement).dataset['draftTag']),
    ).toStrictEqual(['legal', 'Launch']);
    expect(again.view.all('[data-draft-step]').map((row) => row.textContent)).toStrictEqual([
      'Call the client',
    ]);
    expect(valueOf(again.view, '#panel-draft-time')).toBe('30m');
    expect(valueOf(again.view, '#panel-draft-note')).toBe('From the kickoff call.');
  });

  it('Cancel discards the draft on purpose', async () => {
    const storage = store();
    const first = await draft({ storage });
    await fill(first.view);
    await first.view.click('[data-draft="cancel"]');
    expect(first.outcome.closed).toBe(1);
    expect(storage.length).toBe(0);
    await first.view.unmount();
    const again = await draft({ storage });
    expect(valueOf(again.view, '#panel-draft-name')).toBe('');
  });
});

describe('MP-4-13 isolation', () => {
  it('MP-4-13 isolation: a draft is its own person’s, in its own business', async () => {
    const storage = store();
    const ada = await draft({ storage });
    await typeInto(ada.view, '#panel-draft-name', 'Ada’s canary');
    await ada.view.unmount();
    for (const person of ['alpha:grace@example.test', 'bravo:ada@example.test']) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const other = await draft({ storage, person });
      expect(valueOf(other.view, '#panel-draft-name')).toBe('');
      expect(other.view.text()).not.toContain('canary');
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      await other.view.unmount();
    }
  });
});
