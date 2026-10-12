// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Breaks in a board's admission, raced: reads answering in the hostile order, a
// crash at each step, and each retry. A door names a selected project's client
// only from a project read begun after the last break, drawn or not.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import {
  BOARD,
  CLIENT,
  DENIED,
  EMPTY,
  ON_A,
  ON_B,
  OTHER,
  PERSON,
  WITH_PERSON,
  answer,
  emptyDoor,
  leaks,
  lost,
  named,
  projectsPage,
  rejected,
  steeredApi,
  toolbarDoor,
  type Answer,
  type Page,
} from './project-door-client-race-support.tsx';
import { tick } from './task-page-stub.tsx';
import { held, pause } from './work-log-stand-in.tsx';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

type Kind = 'board' | 'people' | 'clients';
const AT_PERSON = `/projects/?board=${BOARD}&person=${PERSON}`;
const FILTERED = `/projects/?board=${BOARD}&f=${encodeURIComponent('client:"Client A"')}`;
const HEALTHY: Record<Kind, Answer> = {
  board: answer(EMPTY),
  people: answer(WITH_PERSON),
  clients: answer({ ok: true, clients: [{ clientId: CLIENT, name: 'Client A' }] }),
};
const out: Answer = () => Promise.resolve(new Response('', { status: 503 }));
const refused = answer(DENIED);
const fakeFloor = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
const drafted = () =>
  [toolbarDoor(), emptyDoor()].map((door) => (door === null ? null : doorContext(door).clientId));

/** Hold each named read's break behind one gate and the project read across it, then serve healthy. */
async function breakAcross(page: Page, broken: Partial<Record<Kind, Answer>>, next?: Answer) {
  const gate = held();
  const across = held();
  const fresh = held();
  for (const [kind, body] of Object.entries(broken) as [Kind, Answer][])
    page.serve[kind] = () => gate.response.then(body);
  page.serve.project = () => across.response;
  await page.invalidate();
  for (const kind of Object.keys(broken) as Kind[]) page.serve[kind] = HEALTHY[kind];
  // One held answer can reach more than one read: each takes its own copy.
  page.serve.project = next ?? (() => fresh.response.then((response) => response.clone()));
  return { gate, across, fresh, before: page.reads.project, from: page.commits.length };
}

/** Land the breaks and the rollup floor's recovery in one React batch. */
async function onFloor(release: () => void, also: () => Promise<void> | void = () => {}) {
  await act(async () => {
    release();
    await pause();
    vi.advanceTimersByTime(30_000);
    await pause();
    await also();
  });
  await tick();
}

/** The read held across the break answers the former client, then the fresh read the new one. */
async function finish(page: Page, run: Awaited<ReturnType<typeof breakAcross>>) {
  run.across.release(ON_A);
  await tick();
  await tick();
  expect(drafted(), 'no door drafts from the read in flight across the break').toEqual([
    null,
    null,
  ]);
  run.fresh.release(ON_B);
  await tick();
  expect(named(page.commits, run.from)).not.toContain(CLIENT);
  expect(leaks(page.commits)).toEqual([]);
  expect(drafted()).toEqual([OTHER, OTHER]);
}

describe('two admission reads break together, answered in the hostile order', () => {
  it('a person list and a client list refused in one batch retire the project read across both', async () => {
    fakeFloor();
    const page = await projectsPage(AT_PERSON);
    expect(drafted()).toEqual([CLIENT, CLIENT]);
    const run = await breakAcross(page, { people: refused, clients: refused });
    await onFloor(() => run.gate.release(null));
    expect(page.reads.project, 'two breaks in one batch start one fresh read').toBe(run.before + 1);
    await finish(page, run);
  });

  it('a board denial and a client list outage in one batch retire the project read across both', async () => {
    fakeFloor();
    const page = await projectsPage(AT_PERSON);
    const run = await breakAcross(page, { board: refused, clients: out });
    await onFloor(() => run.gate.release(null));
    await finish(page, run);
  });

  it('a board outage and a person list without its person, recovered by the live channel, retire the read', async () => {
    const page = await projectsPage(AT_PERSON);
    const run = await breakAcross(page, { board: out, people: answer({ ok: true, persons: [] }) });
    await act(async () => {
      run.gate.release(null);
      await pause();
      page.announce();
      await pause();
    });
    await tick();
    await finish(page, run);
  });
});

describe('a break that answers a read already superseded', () => {
  for (const [kind, address, reread, what] of [
    ['board', undefined, 'invalidate', 'a board denial answering a read a live change superseded'],
    [
      'people',
      AT_PERSON,
      'panelChange',
      'a person list denial answering a read a panel change superseded',
    ],
  ] as const)
    it(`${what} retires the project read sent before it lands`, async () => {
      const page = await projectsPage(address);
      const denial = held();
      const straddling = held();
      page.serve[kind] = () => denial.response;
      page.serve.project = () => held().response;
      await page.invalidate();
      page.serve[kind] = HEALTHY[kind];
      page.serve.project = () => straddling.response;
      await page[reread]();
      page.serve.project = answer(ON_B);
      const from = page.commits.length;
      denial.release(DENIED);
      await tick();
      straddling.release(ON_A);
      await tick();
      await tick();
      expect(drafted(), 'what a door click drafts after the late denial').toEqual([OTHER, OTHER]);
      expect(named(page.commits, from)).not.toContain(CLIENT);
    });
});

describe('a crash at each step of a batched break', () => {
  for (const [step, next] of [
    ['rejects', rejected],
    ['never answers', lost],
    ['answers out', out],
  ] as const)
    it(`a fresh project read that ${step} names no client, and the read across the break never does`, async () => {
      fakeFloor();
      const page = await projectsPage();
      const run = await breakAcross(page, { board: refused }, next);
      await onFloor(() => run.gate.release(null));
      run.across.release(ON_A);
      await tick();
      await tick();
      expect(named(page.commits, run.from)).toEqual([]);
      expect(drafted()).toEqual([null, null]);
    });

  it('a break read that rejects in transport, recovered on the floor, still retires the read across it', async () => {
    fakeFloor();
    const page = await projectsPage();
    const run = await breakAcross(page, { board: rejected });
    await onFloor(() => run.gate.release(null));
    await finish(page, run);
  });

  it('a denial recovered by an answer that is out names no client until the board’s Retry admits', async () => {
    fakeFloor();
    const page = await projectsPage();
    const run = await breakAcross(page, { board: refused });
    page.serve.board = out;
    await onFloor(() => run.gate.release(null));
    run.across.release(ON_A);
    await tick();
    expect(drafted()).toEqual([null, null]);
    page.serve.board = answer(EMPTY);
    page.serve.project = answer(ON_B);
    await page.retry();
    expect(named(page.commits, run.from)).not.toContain(CLIENT);
    expect(drafted()).toEqual([OTHER, OTHER]);
  });
});

describe('each retry path after a break', () => {
  it('an outage drawn, then the board’s Retry, never gives the answer read across the outage', async () => {
    const page = await projectsPage();
    const run = await breakAcross(page, { board: out });
    run.gate.release(null);
    await tick();
    expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
    await page.retry();
    await finish(page, run);
  });

  it('a panel change after a batched break sends one project read and names the client it answers', async () => {
    fakeFloor();
    const page = await projectsPage();
    const run = await breakAcross(page, { board: refused });
    await onFloor(() => run.gate.release(null));
    const last = held();
    page.serve.project = () => last.response;
    await page.panelChange();
    expect(page.reads.project).toBe(run.before + 2);
    run.across.release(ON_A);
    run.fresh.release(ON_A);
    last.release(ON_B);
    await tick();
    expect(drafted()).toEqual([OTHER, OTHER]);
  });

  it('the break count starts the project read once and never again while nothing breaks', async () => {
    fakeFloor();
    const page = await projectsPage();
    const run = await breakAcross(page, { board: refused });
    await onFloor(() => run.gate.release(null));
    await finish(page, run);
    expect(page.reads.project).toBe(run.before + 1);
  });
});

describe('a panel change while the board is denied', () => {
  it('a vocabulary break while the board is denied starts no project read on a panel change', async () => {
    const page = await projectsPage(AT_PERSON);
    page.serve.board = refused;
    await page.invalidate();
    page.serve.people = refused;
    await page.invalidate();
    const before = page.reads.project;
    await page.panelChange();
    await page.panelChange();
    expect(page.reads.project).toBe(before);
    expect(leaks(page.commits)).toEqual([]);
  });
});

describe('other addresses and a reader switch', () => {
  it('a client-scoped board sends no project read across a batched client list break', async () => {
    fakeFloor();
    const page = await projectsPage(`/projects/?board=${BOARD}&client=${CLIENT}`);
    const gate = held();
    page.serve.clients = () => gate.response.then(answer({ ok: true, clients: [] }));
    await page.invalidate();
    page.serve.clients = HEALTHY.clients;
    await onFloor(() => gate.release(null));
    expect(page.reads.project).toBe(0);
    expect(leaks(page.commits)).toEqual([]);
  });

  it('a board denial batched with its recovery under a Client filter retires the read across it', async () => {
    fakeFloor();
    const page = await projectsPage(FILTERED);
    const run = await breakAcross(page, { board: refused });
    await onFloor(() => run.gate.release(null));
    await finish(page, run);
  });

  it('a reader switch in the batch that lands a board break never gives either reader the read across it', async () => {
    fakeFloor();
    const page = await projectsPage();
    const run = await breakAcross(page, { board: refused });
    const beta = steeredApi('beta', 'Client B');
    beta.serve.project = answer(ON_B);
    await onFloor(
      () => run.gate.release(null),
      () => page.view.render(page.screen(0, 'beta:owner', beta.client)),
    );
    run.across.release(ON_A);
    run.fresh.release(ON_A);
    await tick();
    await tick();
    expect(named(page.commits, run.from)).not.toContain(CLIENT);
    expect(drafted()).toEqual([OTHER, OTHER]);
  });
});
