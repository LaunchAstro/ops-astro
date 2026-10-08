// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useTaskPins, type TaskPins } from '../../apps/web/src/screens/task/task-pins.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const accepted = (): Response =>
  Response.json({ recordId: null, revision: null, detail: { preference: 'tasks.pinned' } });
const read = (ids: readonly string[]): Response =>
  Response.json({ preferences: { 'tasks.pinned': ids } });
const refusal = (code = 'FIELD_VALUE_INVALID'): Response =>
  Response.json(
    { refused: true, code, names: ['value'], fixes: ['Pin preference refused.'] },
    { status: 422 },
  );

function api(businessKey = 'alpha') {
  const reads: ((answer: Response) => void)[] = [];
  const saves: { body: Record<string, unknown>; answer: (response: Response) => void }[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    fetch: ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if ('preference' in body) saves.push({ body, answer: resolve });
        else reads.push(resolve);
      })) as typeof globalThis.fetch,
  });
  return { client, reads, saves };
}
async function answer(
  send: ((response: Response) => void) | undefined,
  response: Response,
): Promise<void> {
  expect(send).toBeTypeOf('function');
  await act(() => {
    send?.(response);
  });
  await settle();
}
function probe() {
  let pins: TaskPins | null = null;
  function Probe(props: { client: OperationsClient; owner: string }): ReactElement {
    pins = useTaskPins(props.client, props.owner);
    return <output>{pins.pinnedIds.join(',')}</output>;
  }
  return {
    Probe,
    pins: (): TaskPins => {
      if (pins === null) throw new Error('Probe not mounted');
      return pins;
    },
  };
}

it('loads pins, shares one controller across two consumers, saves only IDs, and remounts from persisted truth', async () => {
  const at = api();
  let control: TaskPins | null = null;
  function Shared(): ReactElement {
    control = useTaskPins(at.client, 'ada');
    return (
      <>
        <button id="board" onClick={() => control?.toggle(FIRST)}>
          Board
        </button>
        <output id="panel">{control.pinnedIds.join(',')}</output>
      </>
    );
  }
  const view = await mount(<Shared />);
  const current = (): TaskPins => {
    if (control === null) throw new Error('Shared not mounted');
    return control;
  };
  expect(current().known).toBe(false);
  await answer(at.reads.shift(), Response.json({ preferences: {} }));
  await view.click('#board');
  expect(view.find('#panel')?.textContent).toBe(FIRST);
  expect(at.saves[0]?.body).toMatchObject({ preference: 'tasks.pinned', value: [FIRST] });
  expect(Object.keys(at.saves[0]?.body ?? {}).toSorted()).toEqual([
    'operationId',
    'preference',
    'value',
  ]);
  await answer(at.saves[0]?.answer, accepted());
  await view.unmount();
  const { Probe, pins } = probe();
  const reopened = await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), read([FIRST]));
  expect(pins().pinnedIds).toEqual([FIRST]);
  await act(() => {
    pins().toggle(FIRST);
  });
  await settle();
  expect(at.saves[1]?.body['value']).toEqual([]);
  await answer(at.saves[1]?.answer, accepted());
  await reopened.unmount();
});

it('an older reread cannot undo a pending save, and two immediate toggles send one command', async () => {
  const at = api();
  const { Probe, pins } = probe();
  await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), read([]));
  await act(() => {
    pins().reload();
    // The fresh read is still loading.
    expect(pins().toggle(FIRST)).toBe(false);
  });
  await answer(at.reads.shift(), read([]));
  await act(() => {
    expect(pins().toggle(FIRST)).toBe(true);
    expect(pins().toggle(SECOND)).toBe(false);
    pins().reload();
  });
  await settle();
  await answer(at.reads.shift(), read([]));
  expect(pins().pinnedIds).toEqual([FIRST]);
  expect(at.saves).toHaveLength(1);
  await answer(at.saves[0]?.answer, accepted());
});

it('unknown saves keep the identical payload and operation ID until explicit retry settles', async () => {
  const at = api();
  const { Probe, pins } = probe();
  await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), read([]));
  await act(() => {
    pins().toggle(FIRST);
  });
  await settle();
  await answer(at.saves[0]?.answer, new Response('No answer', { status: 503 }));
  expect(pins().failure?.kind).toBe('unknown');
  expect(pins().recovery).toBe('retry-save');
  await act(() => {
    expect(pins().toggle(SECOND)).toBe(false);
    pins().reload();
  });
  await answer(at.reads.shift(), read([]));
  expect(pins().pinnedIds).toEqual([FIRST]);
  await act(() => {
    pins().retry();
    pins().retry();
  });
  await settle();
  expect(at.saves).toHaveLength(2);
  expect(at.saves[1]?.body).toEqual(at.saves[0]?.body);
  await answer(at.saves[1]?.answer, accepted());
  expect(pins().failure).toBeNull();
  expect(pins().canToggle).toBe(true);
});

it('a refused save is explained and rereads persisted pins; a closed grant remains locked', async () => {
  const at = api();
  const { Probe, pins } = probe();
  await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), read([SECOND]));
  await act(() => {
    pins().toggle(FIRST);
  });
  await settle();
  await answer(at.saves[0]?.answer, refusal('SCOPE_NOT_GRANTED'));
  expect(pins().failure?.kind).toBe('closed');
  await answer(at.reads.shift(), read([SECOND]));
  expect(pins().pinnedIds).toEqual([SECOND]);
  expect(pins().failure?.because).toContain('Pin preference refused.');
  expect(pins().canToggle).toBe(false);
  await act(() => {
    expect(pins().toggle(FIRST)).toBe(false);
  });
  expect(at.saves).toHaveLength(1);
});

it('client/business/grant changes hide pins immediately and discard old reads, saves and refusal restores', async () => {
  const old = api();
  const next = api('bravo');
  const { Probe, pins } = probe();
  const view = await mount(<Probe client={old.client} owner="ada" />);
  await answer(old.reads.shift(), read([FIRST]));
  await act(() => {
    pins().toggle(SECOND);
  });
  await settle();
  await view.render(<Probe client={next.client} owner="ben" />);
  expect(pins().known).toBe(false);
  expect(pins().pinnedIds).toEqual([]);
  await answer(old.saves[0]?.answer, refusal());
  // No refused save restore read for the abandoned owner.
  expect(old.reads).toHaveLength(0);
  await answer(next.reads.shift(), read([SECOND]));
  expect(pins().pinnedIds).toEqual([SECOND]);
  await act(() => {
    pins().reload();
  });
  const late = next.reads.shift();
  await view.render(<Probe client={next.client} owner="cleo" />);
  await answer(next.reads.shift(), read([]));
  await answer(late, read([FIRST]));
  expect(pins().pinnedIds).toEqual([]);
  expect(pins().failure).toBeNull();
});

it('refused or malformed reads are not an empty known list and invalid/oversized toggles never save', async () => {
  const at = api();
  const { Probe, pins } = probe();
  await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), refusal('SCOPE_NOT_GRANTED'));
  expect(pins().known).toBe(false);
  expect(pins().recovery).toBe('read');
  await act(() => {
    expect(pins().toggle(FIRST)).toBe(false);
    pins().reload();
  });
  await answer(
    at.reads.shift(),
    Response.json({ preferences: { 'tasks.pinned': [FIRST, FIRST] } }),
  );
  expect(pins().known).toBe(false);
  await act(() => {
    pins().reload();
  });
  const most = Array.from(
    { length: 128 },
    (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
  );
  await answer(at.reads.shift(), read(most));
  await act(() => {
    expect(pins().toggle('task-route-key')).toBe(false);
    expect(pins().toggle(FIRST)).toBe(false);
  });
  expect(pins().failure?.kind).toBe('invalid');
  expect(at.saves).toHaveLength(0);
});

it('a late success cannot settle the next grant owner save, and a refusal reread cannot restore across owners', async () => {
  const at = api();
  const { Probe, pins } = probe();
  const view = await mount(<Probe client={at.client} owner="ada" />);
  await answer(at.reads.shift(), read([]));
  await act(() => {
    pins().toggle(FIRST);
  });
  await settle();
  await view.render(<Probe client={at.client} owner="ben" />);
  await answer(at.reads.shift(), read([]));
  await act(() => {
    pins().toggle(SECOND);
  });
  await settle();
  expect(pins().saving).toBe(true);
  // Same-client saves retain their existing queue; Ada's answer only releases the tail.
  await answer(at.saves[0]?.answer, accepted());
  expect(pins().saving).toBe(true);
  expect(pins().pinnedIds).toEqual([SECOND]);
  expect(at.saves[1]?.body['value']).toEqual([SECOND]);
  await answer(at.saves[1]?.answer, refusal());
  const restore = at.reads.shift();
  await view.render(<Probe client={at.client} owner="cleo" />);
  await answer(at.reads.shift(), read([FIRST]));
  await answer(restore, read([SECOND]));
  expect(pins().pinnedIds).toEqual([FIRST]);
  expect(pins().failure).toBeNull();
});

it('a replacement client never treats an older read as known empty pins while the same owner has an unanswered save', async () => {
  const old = api();
  const next = api();
  const { Probe, pins } = probe();
  const view = await mount(<Probe client={old.client} owner="ada" />);
  await answer(old.reads.shift(), read([]));
  await act(() => {
    pins().toggle(FIRST);
  });
  await settle();
  await view.render(<Probe client={next.client} owner="ada" />);
  await answer(next.reads.shift(), read([]));
  expect(pins().known).toBe(false);
  expect(pins().recovery).toBe('read');
  await answer(old.saves[0]?.answer, accepted());
  expect(pins().known).toBe(false);
  await act(() => {
    pins().reload();
  });
  await answer(next.reads.shift(), read([FIRST]));
  expect(pins().known).toBe(true);
  expect(pins().pinnedIds).toEqual([FIRST]);
});
