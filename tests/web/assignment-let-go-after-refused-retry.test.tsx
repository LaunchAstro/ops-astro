// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A lost assignment stays held while a refusal may hide a stored success. The
// person may stop waiting for it: that drops only its saved copy and frees the
// assignee control, and nothing is sent.
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import {
  PERSON,
  assignmentWorld,
  assignmentApp,
  chooseAssignment,
  retryAssignment,
  recoveryCopies,
} from './p05-assignment-recovery-support.tsx';

const ASSIGNEE = 'main select[aria-label="Assignee"]';

it('A lost assignment whose retry is refused SCOPE_NOT_GRANTED can be let go and unlocks the assignee', async () => {
  const world = assignmentWorld('stored');
  const app = await assignmentApp(world, draftTab());
  await chooseAssignment(app, 'page', PERSON);
  const original = String(world.writes[0]?.body['operationId']);
  world.denyWrites(true);
  await retryAssignment(app);
  expect(world.writes).toHaveLength(2);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.find(ASSIGNEE)).toHaveProperty('disabled', true);
  const letGo = app.view.all('button').find((one) => /stop waiting/iu.test(one.textContent ?? ''));
  expect(letGo, 'a held assignment whose retry was refused offers Stop waiting').toBeDefined();
  await app.act(() => (letGo as HTMLButtonElement).click());
  await app.tick();
  expect(recoveryCopies(app.storage).some((raw) => raw?.includes(original))).toBe(false);
  expect(app.view.find(ASSIGNEE)).toHaveProperty('disabled', false);
  expect(
    app.view.all('button').some((one) => /retry assignment/iu.test(one.textContent ?? '')),
  ).toBe(false);
  expect(world.writes).toHaveLength(2);
});
