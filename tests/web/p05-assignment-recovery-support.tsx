// SPDX-License-Identifier: AGPL-3.0-only
import { expect, onTestFinished, vi } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import {
  TASK,
  PERSON,
  OTHER,
  AGENT,
  TITLE,
  NAME,
  OWN_AGENT,
  PEOPLE,
  assignmentWorld,
  assignmentAnswer,
  type RequestCopy,
} from './p05-assignment-server.ts';
export { copied, TASK, PERSON, OTHER, AGENT, TITLE, NAME, assignmentWorld, assignmentAnswer };
const PATH = '/task/Assignment-recovery';
let uuidSequence = 0;
export type AppRealm = Awaited<ReturnType<typeof realm>>;
export type Surface = 'page' | 'panel' | 'board';
export async function assignmentApp(
  world: ReturnType<typeof assignmentWorld>,
  storage?: Storage,
  surface: Surface = 'page',
) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const mint = vi
    .spyOn(globalThis.crypto, 'randomUUID')
    .mockImplementation(
      () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
    );
  onTestFinished(() => mint.mockRestore());
  const app = await realm(world.fetch, storage, surface === 'page' ? PATH : '/projects/');
  if (surface === 'panel') {
    const door = app.view.find('tr[data-row="' + TASK + '"] a.cbd__nm');
    if (!(door instanceof HTMLElement)) throw new Error('Missing actual board-to-panel door');
    await app.act(() =>
      door.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      ),
    );
    await app.tick();
    expect(app.view.find('[data-task-panel]')).not.toBeNull();
  }
  return app;
}

/** Existing mounted selectors choose the first intent; recovery uses its visible semantic button. */
export async function chooseAssignment(
  app: AppRealm,
  surface: Surface,
  value: string | null,
  ownAgent = false,
) {
  if (surface === 'board') {
    const cell = 'tr[data-row="' + TASK + '"] td[data-key="assignee"]';
    await app.view.click(cell + ' button.cbd__edb');
    const label = ownAgent
      ? 'Assign to AI: ' + OWN_AGENT.purpose
      : value === null
        ? 'Unassigned'
        : PEOPLE.find((person) => person.personId === value)?.name;
    const option = app.view
      .all(cell + ' [role="option"]')
      .find((element) => element.textContent === label);
    if (!(option instanceof HTMLElement))
      throw new Error('Missing current authorised assignee choice');
    await app.act(() => option.click());
  } else {
    const selector = ownAgent
      ? surface === 'page'
        ? '#page-assign-ai'
        : '#panel-assign-ai'
      : surface === 'page'
        ? 'main select[aria-label="Assignee"]'
        : '#panel-field-assignee';
    await app.view.choose(selector, value ?? '');
  }
  await app.tick();
}
export function retryControl(view: Mounted): HTMLButtonElement {
  const button = view
    .all('button')
    .find(
      (element) =>
        /retry/iu.test(element.getAttribute('aria-label') ?? element.textContent ?? '') &&
        /assignment/iu.test(element.getAttribute('aria-label') ?? element.textContent ?? ''),
    );
  expect(button, 'a held assignment needs an explicit visible recovery gesture').toBeInstanceOf(
    HTMLButtonElement,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing visible assignment retry');
  return button;
}
export async function retryAssignment(app: AppRealm) {
  const button = retryControl(app.view);
  expect(button.disabled).toBe(false);
  await app.act(() => button.click());
  await app.tick();
}
export function recoveryCopies(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) =>
    storage.getItem(storage.key(index) ?? ''),
  );
}
export function expectHeldCopy(storage: Storage, request: RequestCopy) {
  const raw = recoveryCopies(storage).find((copy) =>
    copy?.includes(String(request.body['operationId'])),
  );
  expect(
    raw,
    'the original assignment operation must have a durable private recovery copy',
  ).toBeDefined();
  expect(raw).toContain(TASK);
  expect(raw).toContain(String(request.body['expectedRevision']));
  expect(raw).not.toContain(TITLE);
  expect(raw).not.toContain(NAME);
}
const missingDeferredAnswer = (): never => {
  throw new Error('Deferred response not initialised');
};
export function deferredAnswer() {
  let release: (response: Response) => void = missingDeferredAnswer;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
