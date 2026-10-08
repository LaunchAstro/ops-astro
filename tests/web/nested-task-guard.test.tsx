// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { tick } from './task-page-stub.tsx';
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function enter(view: Mounted): Promise<void> {
  await act(() => {
    view
      .find('[data-step-add]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
  });
  await tick();
}

it('holds a refused child create closed and never reports a stored child', async () => {
  let sends = 0;
  let changed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () => {
      sends += 1;
      return Promise.resolve(
        json({
          refused: true,
          code: 'SCOPE_NOT_GRANTED',
          names: ['task'],
          fixes: ['ask the owner'],
        }),
      );
    },
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId="parent"
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {
        changed += 1;
      }}
    />,
  );
  await view.type('[data-step-add]', 'Denied child');
  const press = async (): Promise<void> => {
    await act(() => {
      view
        .find('[data-step-add]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
    });
    await tick();
  };
  await press();
  await press();
  expect(sends).toBe(1);
  expect(changed).toBe(0);
  expect(view.text()).toContain('ask the owner');
  expect(view.find('[data-step-add]')?.getAttribute('disabled')).not.toBeNull();
});

it('ignores a late child-create answer after its task surface has left', async () => {
  let answer: ((response: Response) => void) | undefined;
  let changed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId="old-parent"
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {
        changed += 1;
      }}
    />,
  );
  await view.type('[data-step-add]', 'Late child');
  await enter(view);
  await view.render(<p>New owner surface</p>);
  await act(() => {
    answer?.(json({ recordId: 'created-child', revision: 1 }));
  });
  await tick();
  expect(changed).toBe(0);
  expect(view.text()).toBe('New owner surface');
});

it('keeps the pending add box editable and preserves newer words when its first answer lands', async () => {
  let answer: ((response: Response) => void) | undefined;
  let sends = 0;
  let changed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () => {
      sends += 1;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    },
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId="parent"
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {
        changed += 1;
      }}
    />,
  );
  await view.type('[data-step-add]', 'First child');
  await enter(view);
  expect(view.find('[data-step-add]')?.hasAttribute('disabled')).toBe(false);
  await view.type('[data-step-add]', 'Next child');
  await enter(view);
  expect(sends).toBe(1);
  await act(() => {
    answer?.(json({ recordId: 'first-child', revision: 1 }));
  });
  await tick();
  expect(changed).toBe(1);
  expect(view.find('[data-step-add]')?.getAttribute('value')).toBe('Next child');
  expect(document.activeElement).toBe(view.find('[data-step-add]'));
});

it('retries an unanswered create with the identical operation and parent', async () => {
  const bodies: unknown[] = [];
  let minted = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    newOperationId: () => 'held-' + String(++minted),
    fetch: (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        bodies.length === 1
          ? new Response(null, { status: 503 })
          : json({ recordId: 'child', revision: 1 }),
      );
    },
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId="parent"
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {}}
    />,
  );
  await view.type('[data-step-add]', 'Unanswered child');
  await enter(view);
  await enter(view);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    parentId: 'parent',
    fields: { title: 'Unanswered child' },
    operationId: 'held-1',
  });
  expect(minted).toBe(1);
});

it('a still-mounted list changing task ignores its old create callback and preserves the new task words', async () => {
  let answer: ((response: Response) => void) | undefined;
  let changed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  });
  const list = (parentId: string) => (
    <SubtaskList
      client={client}
      parentId={parentId}
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {
        changed += 1;
      }}
    />
  );
  const view = await mount(list('old-parent'));
  await view.type('[data-step-add]', 'Old child');
  await enter(view);
  await view.render(list('new-parent'));
  await view.type('[data-step-add]', 'New task words');
  const origin = view.find('[data-step-add]');
  await act(() => {
    answer?.(json({ recordId: 'old-child', revision: 1 }));
  });
  await tick();
  expect(changed).toBe(0);
  expect(view.find('[data-step-add]')).toBe(origin);
  expect(origin?.getAttribute('value')).toBe('New task words');
});
