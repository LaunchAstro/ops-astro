// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects page against an API whose board, project and client list
// answers a test steers, probed at every commit, for the race proofs on a
// selected project's client at the board's New task doors
// (`project-door-client-hostile-order.test.tsx`,
// `project-door-client-crash-and-retry.test.tsx`).

import { Profiler, type ReactElement, type ReactNode } from 'react';
import { expect } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount } from '../surfaces/mount.tsx';
import { task, tick } from './task-page-stub.tsx';
import { held, json } from './work-log-stand-in.tsx';

export const CLIENT = '11111111-1111-4111-8111-111111111111';
export const BOARD = '22222222-2222-4222-8222-222222222222';
export const OTHER = '66666666-6666-4666-8666-666666666666';
export const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
export const EMPTY = { ok: true, tasks: [] };
export const projectOn = (client: string, name: string) => ({
  ok: true,
  task: task({ id: BOARD, client, clientSummary: { kind: 'readable', name } }),
  states: [],
});
export const ON_A = projectOn(CLIENT, 'Client A');
export const ON_B = projectOn(OTHER, 'Client B');

export type Answer = () => Promise<Response>;
export const answer =
  (body: unknown): Answer =>
  () =>
    Promise.resolve(json(body));
/** A held answer the server gives as an outage (503, no refusal), whatever it is released with. */
export const outage = (gate: ReturnType<typeof held>): Answer => {
  return () => gate.response.then(() => new Response('', { status: 503 }));
};
export const lost: Answer = () => new Promise<Response>(() => {});
export const rejected: Answer = () => Promise.reject(new TypeError('Failed to fetch'));

/** An API whose board, project and client list answers a test steers, with the tab's live stream. */
export function steeredApi(businessKey = 'alpha', clientName = 'Client A') {
  const serve: { board: Answer; project: Answer; clients: Answer } = {
    board: answer(EMPTY),
    project: answer(ON_A),
    clients: answer({ ok: true, clients: [{ clientId: CLIENT, name: clientName }] }),
  };
  const reads = { board: 0, project: 0 };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://local').pathname;
    if (path.endsWith('/live'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            init?.signal?.addEventListener('abort', () => streams.delete(controller));
          },
        }),
      );
    if (path.endsWith('/task/read')) {
      reads.project += 1;
      return await serve.project();
    }
    if (path.endsWith('/task/board')) {
      reads.board += 1;
      return await serve.board();
    }
    if (path.endsWith('/client/list')) return await serve.clients();
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    return json({ ok: true });
  };
  const client = new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  /** The live channel's board change, sent without waiting for anything it starts. */
  const announce = (): void => {
    for (const stream of streams)
      stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
  };
  const invalidate = async (): Promise<void> => {
    announce();
    await tick();
    await tick();
  };
  return { client, serve, reads, announce, invalidate };
}

/** What one commit drew: the board's read state and each door's client. */
export interface Commit {
  readonly board: string;
  readonly toolbar: string | undefined;
  readonly toolbarName: string | undefined;
  readonly empty: string | undefined;
  readonly emptyName: string | undefined;
}

export const toolbarDoor = () => document.querySelector<HTMLElement>('[data-projects-new-task]');
export const emptyDoor = () =>
  document.querySelector<HTMLElement>('[data-projects-empty-new-task]');

/** The board's own read state: the last read state drawn, a kept load named apart from a bare one. */
export function boardState(): string {
  const states = [...document.querySelectorAll<HTMLElement>('.projects [data-outcome]')];
  const last = states.at(-1);
  if (last === undefined) return 'none';
  const outcome = last.dataset['outcome'] ?? 'none';
  return outcome === 'loading' && last.getAttribute('aria-busy') === 'true' ? 'kept' : outcome;
}

export function snapshot(): Commit {
  return {
    board: boardState(),
    toolbar: toolbarDoor()?.dataset['newTaskClient'],
    toolbarName: toolbarDoor()?.dataset['newTaskClientName'],
    empty: emptyDoor()?.dataset['newTaskClient'],
    emptyName: emptyDoor()?.dataset['newTaskClientName'],
  };
}

/** Records every commit anywhere in the page, as React finishes it and before any passive effect. */
export function Probe(props: {
  readonly commits: Commit[];
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Profiler id="projects" onRender={() => props.commits.push(snapshot())}>
      {props.children}
    </Profiler>
  );
}

/** A board state in which the reader is not admitted: no door may name a client. */
export const unadmitted = (commit: Commit): boolean =>
  commit.board === 'denied' || commit.board === 'unavailable' || commit.board === 'loading';

export const toolbarNames = (commit: Commit): boolean =>
  commit.toolbar !== undefined || commit.toolbarName !== undefined;
export const emptyNames = (commit: Commit): boolean =>
  commit.empty !== undefined || commit.emptyName !== undefined;

/** Each commit in which either door named a client while the board did not admit the reader. */
export const leaks = (commits: readonly Commit[]): readonly Commit[] =>
  commits.filter((commit) => unadmitted(commit) && (toolbarNames(commit) || emptyNames(commit)));

/** Every client either door named from commit `from` on. */
export const named = (commits: readonly Commit[], from = 0): readonly string[] =>
  commits
    .slice(from)
    .flatMap((commit) => [commit.toolbar, commit.empty])
    .filter((one) => one !== undefined);

/** The Projects page at `address`, probed at every commit from its first mount. */
export async function projectsPage(
  address = `/projects/?board=${BOARD}`,
  prepare: (api: ReturnType<typeof steeredApi>) => void = () => {},
) {
  const api = steeredApi();
  prepare(api);
  const commits: Commit[] = [];
  let shown = { changes: 0, grantKey: 'alpha:owner', on: api.client };
  const screen = (
    changes = shown.changes,
    grantKey = shown.grantKey,
    on = shown.on,
  ): ReactElement => {
    shown = { changes, grantKey, on };
    return (
      <Probe commits={commits}>
        <Projects
          client={on}
          grantKey={grantKey}
          navigate={() => {}}
          canFileTask
          taskPanel={{ open: () => {}, changes }}
        />
      </Probe>
    );
  };
  window.history.replaceState(null, '', address);
  const view = await mount(screen());
  await tick();
  await tick();
  /** The task panel reports a change, as an edit in an open panel does. */
  const panelChange = async (): Promise<void> => {
    await view.render(screen(shown.changes + 1));
    await tick();
    await tick();
  };
  /** The board's Retry, drawn on an outage. */
  const retry = async (): Promise<void> => {
    await view.click('[data-outcome="unavailable"] button');
    await tick();
    await tick();
  };
  return { ...api, view, screen, commits, panelChange, retry };
}

export type Page = Awaited<ReturnType<typeof projectsPage>>;

/**
 * Deny the board on a live change while the project read started by that
 * change is held, so its answer is minted before the denial. Returns the held
 * project answer.
 */
export async function denyWithProjectHeld(page: Page): Promise<ReturnType<typeof held>> {
  const across = held();
  page.serve.project = () => across.response;
  page.serve.board = answer(DENIED);
  await page.invalidate();
  expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
  return across;
}

/** The settled door state: what a click on either door would copy into a draft. */
export const settled = () => ({
  toolbar: toolbarDoor()?.dataset['newTaskClient'],
  toolbarName: toolbarDoor()?.dataset['newTaskClientName'],
  empty: emptyDoor()?.dataset['newTaskClient'],
});
