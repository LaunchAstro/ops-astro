// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-20 (red proof): the Projects board must stay mounted while it
// re-reads. Projects.tsx draws the board through `RecordState` without
// `keep`, so every re-read (`begin()` publishes loading) draws the loading
// line in place of the board and unmounts it. The remounted board opens again
// on the viewer preset and drops whatever the person had open: a Clear all
// comes undone after an edit, and a rename draft is lost under a live change.
// Fixed when the board's `RecordState` keeps the last answer drawn while its
// re-read is in flight (`keep`, as the inbox does).

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
beforeEach(() => {
  window.history.replaceState(null, '', '/projects/');
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADA = { personId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Ada Park' };
const BEN = { personId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Ben Ito' };

const task = (id: string, key: string, over: Readonly<Record<string, unknown>>) => ({
  id,
  key,
  title: `Task ${key}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 3,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 2000,
  awaitingDecision: false,
  ...over,
});

// Ada is the viewer; one task is hers, the other Ben's.
const TASKS = [
  task(MINE, 'TSK-1', { assignee: ADA, stage: 'Drafting' }),
  task(THEIRS, 'TSK-2', { assignee: BEN, stage: 'Review' }),
];

interface Server {
  readonly fetch: typeof globalThis.fetch;
  readonly boardReads: () => number;
  /** Send one event down the tab's live stream. */
  readonly push: (event: string) => void;
  /** Answer the board re-read held in flight (the network's latency, made explicit). */
  readonly release: () => void;
}

/**
 * Answers the board (viewer Ada), the people and every command with success;
 * the live stream is the test's. Every board read after the first is held in
 * flight until `release`, as a real network holds it, so the screen draws the
 * re-read's loading state in between.
 */
function server(): Server {
  let reads = 0;
  const held: (() => void)[] = [];
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = ((url: string) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.endsWith('/task/board')) {
      reads += 1;
      const answer = (): Response =>
        json({ ok: true, tasks: TASKS, changedAt: null, viewer: ADA.personId, withheld: 0 });
      if (reads === 1) return Promise.resolve(answer());
      return new Promise<Response>((resolve) => {
        held.push(() => {
          resolve(answer());
        });
      });
    }
    if (at.endsWith('person/list')) return Promise.resolve(json({ ok: true, persons: [ADA, BEN] }));
    return Promise.resolve(json({ ok: true, recordId: THEIRS, revision: 4, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    boardReads: () => reads,
    push: (event) => {
      for (const each of streams) each.enqueue(encoder.encode(event));
    },
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

const ROW = (id: string): string => `tr[data-row="${id}"]`;
const CELL = (id: string, key: string): string => `${ROW(id)} td[data-key="${key}"]`;
const RENAME = `${ROW(MINE)} input.cbd__rename`;

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass flushes the next hop
    await settle();
  }
};

const fire = async (target: Element | null, event: Event): Promise<void> => {
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    target?.dispatchEvent(event);
  });
};

const open = async (answers: Server): Promise<Mounted> => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: answers.fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const board = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:ada" />);
  await settleAll();
  return board;
};

describe('REVIEW-2C1-20 the Projects board stays mounted while it re-reads', () => {
  it('REVIEW-2C1-20: an edit after Clear all re-reads the board, and the remounted board reopens on the viewer preset, hiding the row just edited', async () => {
    const answers = server();
    mounted = await open(answers);
    // Opens on the viewer preset: Ada's row only.
    expect(mounted.find(ROW(THEIRS))).toBeNull();
    await mounted.click('button.cbd__clear');
    await settleAll();
    expect(mounted.find(ROW(THEIRS))).not.toBeNull();
    expect(window.location.search).not.toMatch(/(^|[?&])f=/u);

    // Change the stage on Ben's row; the outcome re-reads the board.
    await mounted.click(`${CELL(THEIRS, 'stage')} button.cbd__edb`);
    const option = mounted
      .all(`${CELL(THEIRS, 'stage')} .sel__menu [role="option"]`)
      .find((each) => each.textContent === 'Drafting');
    expect(option).toBeDefined();
    await fire(option ?? null, new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settleAll();
    expect(answers.boardReads()).toBe(2);
    answers.release();
    await settleAll();

    expect(
      mounted.find(ROW(THEIRS)),
      'the row just edited is still drawn: Clear all survives the re-read',
    ).not.toBeNull();
    expect(window.location.search, 'the address has no filter back').not.toMatch(/(^|[?&])f=/u);
  });

  it('REVIEW-2C1-20: a live re-read of the board while a name is being renamed unmounts the board and loses the draft', async () => {
    const answers = server();
    mounted = await open(answers);
    await fire(
      mounted.find(`${ROW(MINE)} .cbd__nm`),
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
    await mounted.type(RENAME, 'A draft not yet saved');
    expect((mounted.find(RENAME) as HTMLInputElement | null)?.value).toBe('A draft not yet saved');

    // Somebody else changes the board: the stream says so and the board re-reads.
    answers.push('event: invalidate\ndata: board\n\n');
    await settleAll();
    expect(answers.boardReads()).toBe(2);
    answers.release();
    await settleAll();

    const input = mounted.find(RENAME) as HTMLInputElement | null;
    expect(input, 'the rename input is still drawn after the re-read').not.toBeNull();
    expect(input?.value).toBe('A draft not yet saved');
  });
});
