// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it, onTestFinished } from 'vitest';
import {
  PERSON,
  TITLE,
  assignmentWorld,
  assignmentApp,
  chooseAssignment,
  retryAssignment,
  expectHeldCopy,
} from './p05-assignment-recovery-support.tsx';
import { refused } from './p05-assignment-http.ts';

type Denial = 'vocabulary' | 'board';
function scopedWorld() {
  const world = assignmentWorld();
  const fetch = world.fetch;
  let vocabularyDenied = false;
  const boards: unknown[] = [];
  world.fetch = (input, init) => {
    const path = new URL(String(input), 'http://synthetic.invalid').pathname;
    if (path.endsWith('/task/board'))
      boards.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    if (path.endsWith('/person/list') && vocabularyDenied)
      return Promise.resolve(refused('SCOPE_NOT_GRANTED'));
    return fetch(input, init);
  };
  return {
    world,
    boards,
    deny: (kind: Denial, denied: boolean) => {
      if (kind === 'vocabulary') vocabularyDenied = denied;
      else world.denyReads(denied);
    },
  };
}
async function refreshBoard(app: Awaited<ReturnType<typeof assignmentApp>>) {
  await app.act(async () => {
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
  });
  await app.tick();
}

it.each(['vocabulary', 'board'] as const)(
  'actual App scoped board withdraws held assignment labels on %s denial, then retries exactly',
  async (kind) => {
    const scope = scopedWorld();
    const app = await assignmentApp(scope.world, undefined, 'board');
    onTestFinished(() => app.view.unmount());
    await chooseAssignment(app, 'board', PERSON);
    const original = scope.world.writes[0]!;
    await app.renderPath('/projects/?pool=aggregate&person=' + PERSON);
    await app.tick();
    expect(scope.boards.at(-1)).toStrictEqual({ mode: 'aggregate', person: PERSON });
    expect(app.view.find('[data-assignment-recovery]')?.textContent).toContain(TITLE);
    expectHeldCopy(app.storage, original);
    scope.deny(kind, true);
    await refreshBoard(app);
    expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(app.view.find('[data-assignment-recovery]')).toBeNull();
    expect(app.view.text()).not.toContain(TITLE);
    expect(scope.world.writes).toHaveLength(1);
    expectHeldCopy(app.storage, original);
    scope.deny(kind, false);
    await refreshBoard(app);
    expect(scope.boards.at(-1)).toStrictEqual({ mode: 'aggregate', person: PERSON });
    expect(app.view.find('[data-assignment-recovery]')?.textContent).toContain(TITLE);
    expect(scope.world.writes).toHaveLength(1);
    await retryAssignment(app);
    expect(scope.world.writes[1]).toEqual(original);
    expect(scope.world.applications).toHaveLength(1);
  },
);
