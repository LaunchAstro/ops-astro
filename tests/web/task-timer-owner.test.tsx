// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  TaskTimerProvider,
  TaskTimerButton,
  TaskTimerStrip,
  useTimerRead,
} from '../../apps/web/src/screens/task/task-timer-context.tsx';
import { mount } from '../surfaces/mount.tsx';
import { task } from './task-page-stub.tsx';
import { A, START } from './task-bound-timer-support.tsx';

const noRelease = (_value: Response): void => {};
const applied = () =>
  new Response(
    JSON.stringify({
      recordId: null,
      revision: null,
      detail: { entryId: 'entry-a', startedAt: START },
    }),
  );
const refused = () =>
  new Response(JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }), {
    status: 403,
  });
function transport(answer: () => Promise<Response>) {
  const sent: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return answer();
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
  };
}
const draw = (client: OperationsClient, grantKey = 'owner-a') => (
  <TaskTimerProvider client={client} grantKey={grantKey}>
    <TaskTimerButton task={{ id: A, key: 'Timer-A', title: 'Alpha work' }} busy={false} />
    <TaskTimerStrip onSelect={() => {}} />
    <ReadDoor client={client} record="Timer-A" />
    <ReadDoor client={client} record={A} />
  </TaskTimerProvider>
);

it('same-owner transport rotation retains a pending exact Start and ignores its late old answer', async () => {
  let release = noRelease;
  const old = transport(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const next = transport(() => Promise.resolve(applied()));
  const view = await mount(draw(old.client));
  await view.click('[data-timer]');
  await view.render(draw(next.client));
  expect(view.find('[data-task-timer-retry]')).not.toBeNull();
  await act(() => release(applied()));
  expect(view.find('[data-task-timer-retry]')).not.toBeNull();
  await view.click('[data-task-timer-retry]');
  expect(next.sent).toEqual(old.sent);
  expect(view.text()).toContain('Alpha work');
});

it('a refused replay keeps the unresolved effect and exact operation identity', async () => {
  const old = transport(() => Promise.reject(new TypeError('lost answer')));
  const denied = transport(() => Promise.resolve(refused()));
  const next = transport(() => Promise.resolve(applied()));
  const view = await mount(draw(old.client));
  await view.click('[data-timer]');
  await view.render(draw(denied.client));
  await view.click('[data-task-timer-retry]');
  expect(view.text()).toContain('outcome unknown');
  expect(view.text()).not.toContain('Dismiss refusal');
  await view.render(draw(next.client));
  await view.click('[data-task-timer-retry]');
  expect(next.sent).toEqual(old.sent);
  expect(denied.sent).toEqual(old.sent);
});

it('a new owner hides the old binding and cannot replay the old owner’s unknown write', async () => {
  const old = transport(() => Promise.reject(new TypeError('lost answer')));
  const next = transport(() => Promise.resolve(applied()));
  const view = await mount(draw(old.client));
  await view.click('[data-timer]');
  await view.render(draw(next.client, 'owner-b'));
  expect(view.find('[data-task-timer-retry]')).toBeNull();
  expect(view.text()).not.toContain('Alpha work');
  expect(next.sent).toEqual([]);
});

it('a refused retry on the same transport does not erase its earlier uncertain effect', async () => {
  let calls = 0;
  const wire = transport(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new TypeError('lost answer'));
    return Promise.resolve(calls === 2 ? refused() : applied());
  });
  const view = await mount(draw(wire.client));
  await view.click('[data-timer]');
  await view.click('[data-task-timer-retry]');
  expect(view.text()).toContain('outcome unknown');
  expect(view.text()).not.toContain('Dismiss refusal');
  await view.click('[data-task-timer-retry]');
  expect(wire.sent).toEqual([wire.sent[0], wire.sent[0], wire.sent[0]]);
  expect(view.text()).toContain('Alpha work');
});

it('same-owner rotation keeps the known task pointer and routes Stop through the admitted client', async () => {
  const old = transport(() => Promise.resolve(applied()));
  const next = transport(() => Promise.resolve(applied()));
  const view = await mount(draw(old.client));
  await view.click('[data-timer]');
  await view.render(draw(next.client));
  expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
  await view.click('[data-task-timer-strip] [data-timer]');
  expect(old.sent).toHaveLength(1);
  expect(next.sent).toHaveLength(1);
  expect(next.sent[0]?.['taskId']).toBe(A);
  expect(next.sent[0]?.['operationId']).not.toBe(old.sent[0]?.['operationId']);
  expect(view.find('[data-task-timer-strip]')?.textContent).toBe('Select task to time');
});

const authorised = () =>
  new Response(
    JSON.stringify({
      ok: true,
      task: task({
        id: A,
        key: 'Timer-A',
        title: 'Alpha work',
        time: { entries: [], totalMinutes: 0, running: { entryId: 'entry-a', startedAt: START } },
      }),
    }),
  );

function ReadDoor(props: { readonly client: OperationsClient; readonly record: string }) {
  const read = useTimerRead(props.client, props.record);
  return (
    <button data-read={props.record} onClick={() => void read.run()}>
      Read
    </button>
  );
}

for (const deniedKey of ['Timer-A', A]) {
  it(`an older authorised task read cannot restore labels after ${deniedKey} is denied`, async () => {
    let release = noRelease;
    let calls = 0;
    const wire = transport(() => {
      calls += 1;
      if (calls === 2)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(calls === 3 ? refused() : calls === 4 ? authorised() : applied());
    });
    const view = await mount(draw(wire.client));
    await view.click('[data-timer]');
    await view.click('[data-read="Timer-A"]');
    await view.click(`[data-read="${deniedKey}"]`);
    expect(view.find('[data-task-timer-strip]')?.textContent).not.toContain('Alpha work');
    await act(() => release(authorised()));
    expect(view.find('[data-task-timer-strip]')?.textContent).not.toContain('Alpha work');
    expect(view.find('[data-task-timer-strip] [data-timer]')?.hasAttribute('disabled')).toBe(false);
    await view.click('[data-read="Timer-A"]');
    expect(view.find('[data-task-timer-strip]')?.textContent).toContain('Alpha work');
    await view.click('[data-task-timer-strip] [data-timer]');
    expect(wire.sent.at(-1)?.['taskId']).toBe(A);
    expect(view.find('[data-task-timer-strip]')?.textContent).toBe('Select task to time');
  });
}
