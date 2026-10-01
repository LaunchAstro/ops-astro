// SPDX-License-Identifier: AGPL-3.0-only
import type { SSEStreamingApi } from 'hono/streaming';
import { expect, it, vi } from 'vitest';
import { followBoard, type BoardQuestions } from '../../apps/api/live-board.ts';
import type { BoardSignal, LiveTopics } from '../../apps/api/live.ts';

function rig(questions: BoardQuestions) {
  const writes: { event: string; data: string }[] = [];
  const onAbort: (() => void)[] = [];
  let aborted = false;
  const stream = {
    get aborted() { return aborted; },
    onAbort(callback: () => void) { onAbort.push(callback); },
    writeSSE(frame: { event: string; data: string }) {
      writes.push(frame);
      return Promise.resolve();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of onAbort) callback();
    },
  } as unknown as SSEStreamingApi;
  let emit = (_signal: BoardSignal): void => {};
  const topics = {
    subscribeBoard: (_business: string, _person: string, send: (signal: BoardSignal) => void) => {
      emit = send;
      return () => {};
    },
  } as unknown as LiveTopics;
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const running = followBoard(stream, topics, {
    businessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', personId, recheckMs: 100_000,
  }, questions);
  const stop = async () => { stream.abort(); await running; };
  return { writes, emit: (signal: BoardSignal) => emit(signal), stop, personId };
}

const resyncs = (writes: readonly { event: string }[]) =>
  writes.filter((frame) => frame.event === 'resync').length;

it('a hidden inbox item cannot borrow a stale digest after a visible task resync', async () => {
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let shown = 'before title change';
  const board = rig({
    joinedAs: () => Promise.resolve(personId),
    reads: () => Promise.resolve(true),
    reach: () => Promise.resolve('same visible tasks'),
    shown: () => Promise.resolve(shown),
  });
  try {
    await vi.waitFor(() => expect(resyncs(board.writes)).toBe(1));
    shown = 'after visible task title change';
    board.emit({ kind: 'task', taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    await vi.waitFor(() => expect(resyncs(board.writes)).toBe(2));
    board.emit({ kind: 'inbox' }); // The hidden item changes nothing in `shown`.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(board.writes.filter((frame) => frame.event === 'inbox')).toEqual([]);
  } finally {
    await board.stop();
  }
});

it('a remapped bearer hears no old-person task resync while reach is in flight', async () => {
  const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const second = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let currentPerson = first;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reachCalls = 0;
  const board = rig({
    joinedAs: () => Promise.resolve(currentPerson),
    reads: (_task, personId) => Promise.resolve(personId === first),
    shown: () => Promise.resolve('inbox'),
    reach: async () => {
      reachCalls += 1;
      if (reachCalls === 2) await held;
      return 'same visible tasks';
    },
  });
  try {
    await vi.waitFor(() => expect(resyncs(board.writes)).toBe(1));
    board.emit({ kind: 'task', taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    await vi.waitFor(() => expect(reachCalls).toBe(2));
    currentPerson = second;
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(resyncs(board.writes)).toBe(1);
  } finally {
    release();
    await board.stop();
  }
});
