// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { COMMAND_SURFACE, pathOf, type BoardCrumb } from '../../packages/core-wire/src/index.ts';
import { task, tick } from './task-page-stub.tsx';
import { boardA, destinationTask } from './projects-board-destination-support.tsx';
import { draftApp, draftReply, type Sent } from './projects-draft-app-support.tsx';

export { boardA, tick };
export const KEY = 'Scope-1';
export const ID = '00000000-0000-4000-8000-000000000001';
export const PAGE_DOOR = 'a[data-crumb="projects"]';
export const PANEL_DOOR = 'a[data-panel-head="board"]';
export const PANEL_OPEN = '#perspective-panel-team [data-panel-door="log"]';
export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const denial = () => json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);

interface State {
  board: BoardCrumb | null;
  taskDenied: boolean;
  boardDenied: boolean;
  targetAbsent: boolean;
  held: boolean;
  release: (() => void) | null;
  running: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
}
function taskAnswer(state: State): Response {
  return state.taskDenied
    ? denial()
    : json({
        ok: true,
        task: task({
          id: ID,
          key: KEY,
          title: 'Admitted target',
          board: state.board,
          time: {
            entries: [],
            running: state.running
              ? {
                  entryId: '99999999-9999-4999-8999-999999999999',
                  startedAt: '2026-10-08T01:00:00Z',
                }
              : null,
            totalMinutes: 0,
          },
        }),
      });
}
function boardAnswer(state: State): Response {
  return state.boardDenied
    ? denial()
    : json({
        ok: true,
        tasks: state.targetAbsent
          ? []
          : [
              {
                ...destinationTask(state.board?.readable ? state.board.id : null, 0),
                title: 'Admitted target',
                assignee: null,
                client: null,
              },
            ],
        changedAt: null,
        viewer: 'viewer',
        owed: 0,
      });
}
function reply(state: State, sent: Sent): Promise<Response> {
  if (sent.path === '/task/read') return Promise.resolve(taskAnswer(state));
  if (sent.path === '/task/board') {
    if (!state.held) return Promise.resolve(boardAnswer(state));
    return new Promise<Response>((resolve) => {
      state.release = () => resolve(boardAnswer(state));
    });
  }
  if (sent.path === '/task/execution') return Promise.resolve(denial());
  if (sent.path.includes('/live?') || sent.path.endsWith('/live'))
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            state.controller = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  return Promise.resolve(draftReply(sent));
}
const DEFAULT_BOARD: BoardCrumb = { readable: true, id: boardA, title: 'Current board' };
export async function boardDoorApp(board: BoardCrumb | null = DEFAULT_BOARD) {
  const state: State = {
    board,
    taskDenied: false,
    boardDenied: false,
    targetAbsent: false,
    held: false,
    release: null,
    running: false,
    controller: null,
  };
  const app = await draftApp({ path: `/task/${KEY}`, reply: (sent) => reply(state, sent) });
  await tick();
  const reread = async (): Promise<void> => {
    const before = app.sent.filter((sent) => sent.path === '/task/read').length;
    if (state.controller === null) throw new Error('Task live stream was not opened');
    await act(async () => {
      state.controller?.enqueue(
        new TextEncoder().encode(`event: invalidate\ndata: task:${ID}\n\n`),
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    await tick();
    if (app.sent.filter((sent) => sent.path === '/task/read').length <= before)
      throw new Error('Live invalidation did not request a current task read');
  };
  const release = async (): Promise<void> => {
    state.held = false;
    await act(() => {
      state.release?.();
    });
    await tick();
  };
  return { ...app, state, reread, release };
}
export async function panelOf(app: Awaited<ReturnType<typeof boardDoorApp>>): Promise<void> {
  await app.view.click(PANEL_OPEN);
  await tick();
}
const READ_PATHS = new Set(
  COMMAND_SURFACE.filter((entry) => entry.kind === 'read').map((entry) => pathOf(entry.name)),
);
export const commands = (sent: readonly Sent[]) =>
  sent.filter(
    (one) =>
      !READ_PATHS.has(one.path) && !one.path.includes('/live?') && !one.path.endsWith('/live'),
  );
export async function modified(
  app: Awaited<ReturnType<typeof boardDoorApp>>,
  door: string,
  modifier: 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey',
): Promise<void> {
  const anchor = app.view.find(door);
  if (anchor === null) throw new Error(`No owning-board anchor matches ${door}`);
  await act(() => {
    anchor.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        [modifier]: true,
      }),
    );
  });
  await tick();
}
