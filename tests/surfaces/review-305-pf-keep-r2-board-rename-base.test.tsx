// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep round 2: the Projects board stays mounted under a
// re-read, so a rename opened before a colleague's change is still open after
// it. The name typed there was based on the revision the rename opened at,
// and is sent at that revision, so the colleague's change answers
// VERSION_STALE rather than being overwritten. The harness is REVIEW-2C1-20's,
// with each re-read answering the task one revision on.

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

interface Server {
  readonly fetch: typeof globalThis.fetch;
  readonly boardReads: () => number;
  readonly updates: () => readonly Readonly<Record<string, unknown>>[];
  /** Send one event down the tab's live stream. */
  readonly push: (event: string) => void;
  /** Answer the board re-read held in flight (the network's latency, made explicit). */
  readonly release: () => void;
}

/** A live stream the test writes to: its controller joins `streams`. */
function liveStream(streams: ReadableStreamDefaultController<Uint8Array>[]): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      streams.push(controller);
    },
  });
  return Promise.resolve(new Response(body, { status: 200 }));
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
  const updates: Readonly<Record<string, unknown>>[] = [];
  const fetch = ((url: string, init?: { body?: string }) => {
    const at = String(url);
    if (at.endsWith('/task/update')) {
      updates.push(JSON.parse(init?.body ?? '{}') as Readonly<Record<string, unknown>>);
    }
    if (/\/live(\?|$)/u.test(at)) return liveStream(streams);
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.endsWith('/task/board')) {
      reads += 1;
      const revision = 2 + reads;
      const answer = (): Response =>
        json({
          ok: true,
          tasks: [
            task(MINE, 'TSK-1', { assignee: ADA, stage: 'Drafting', revision }),
            task(THEIRS, 'TSK-2', { assignee: BEN, stage: 'Review', revision }),
          ],
          changedAt: null,
          viewer: ADA.personId,
          withheld: 0,
        });
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
    updates: () => updates,
    push: (event) => {
      for (const each of streams) each.enqueue(encoder.encode(event));
    },
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
  };
}

const ROW = (id: string): string => `tr[data-row="${id}"]`;
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

describe('review/305-pf-keep round 2: the board rename under a re-read', () => {
  it('a rename opened before a colleague changed the task is sent at the revision it opened at', async () => {
    const answers = server();
    mounted = await open(answers);
    await fire(
      mounted.find(`${ROW(MINE)} .cbd__nm`),
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    );
    answers.push('event: invalidate\ndata: board\n\n');
    await settleAll();
    answers.release();
    await settleAll();
    await mounted.type(RENAME, 'A name typed over the old one');
    await fire(
      mounted.find(`${RENAME}`),
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await settleAll();
    expect(answers.updates()).toHaveLength(1);
    expect(
      answers.updates()[0]?.['expectedRevision'],
      "the rename was sent at the re-read's revision, over the colleague's change",
    ).toBe(3);
  });
});
