// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An enrolment that never answers holds back only the same person's next
// enrolment in that business, which it could still replace when it lands. A
// different owner's set-up sends at once. The same person waits across a
// step-up, a switch away and back and a sign-out and in, and two of their
// panels send one at a time.

import type { ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { AuthenticatorSetup } from '../../apps/web/src/screens/settings/authenticator.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { settle } from './mp-2-1-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const ISSUED = {
  ok: true,
  value: { qrCode: 'data:image/svg+xml,<svg/>', secret: 'BRAVO-SECRET' },
};

function owner(answer: () => Promise<unknown>): { client: OperationsClient; sent: () => number } {
  let sent = 0;
  const client = {
    enrolFactor: () => {
      sent += 1;
      return answer();
    },
  } as unknown as OperationsClient;
  return { client, sent: () => sent };
}

const panel = (grantKey: string, client: OperationsClient): ReactElement => (
  <StepUpContext.Provider value={() => Promise.resolve({ ok: true } as never)}>
    <AuthenticatorSetup key={grantKey} grantKey={grantKey} client={client} />
  </StepUpContext.Provider>
);

async function startThenCancel(grantKey: string, client: OperationsClient): Promise<void> {
  mounted = await mount(panel(grantKey, client));
  await mounted.click('[data-factor="enrol"] button');
  await mounted.click('[data-factor="cancel"] button');
  await mounted.unmount();
  mounted = undefined;
}

it('a cancelled enrolment that never answers does not stop another owner setting up', async () => {
  const alpha = owner(() => new Promise(() => {}));
  await startThenCancel('alpha:ada@example.test:0', alpha.client);
  const bravo = owner(() => Promise.resolve(ISSUED));
  mounted = await mount(panel('bravo:bea@example.test:0', bravo.client));
  await mounted.click('[data-factor="enrol"] button');
  await settle();
  expect(alpha.sent()).toBe(1);
  expect(bravo.sent()).toBe(1);
  expect(mounted.text()).toContain('BRAVO-SECRET');
  expect(mounted.text()).not.toContain('Setting up…');
});

it('the same person’s next enrolment still waits for their earlier one to land', async () => {
  const landed: ((value: unknown) => void)[] = [];
  const first = owner(
    () =>
      new Promise((resolve) => {
        landed.push(resolve);
      }),
  );
  await startThenCancel('carol:cy@example.test:0', first.client);
  const again = owner(() => Promise.resolve(ISSUED));
  mounted = await mount(panel('carol:cy@example.test:0', again.client));
  await mounted.click('[data-factor="enrol"] button');
  await settle();
  expect(again.sent()).toBe(0);
  for (const land of landed) land({ unavailable: true, because: 'gone' });
  await settle();
  expect(again.sent()).toBe(1);
});

it('the same person back in the same business after a switch or a sign-out still waits for their earlier enrolment', async () => {
  const landed: ((value: unknown) => void)[] = [];
  const first = owner(
    () =>
      new Promise((resolve) => {
        landed.push(resolve);
      }),
  );
  await startThenCancel('delta:di@example.test:0', first.client);
  // Away to another business and back, or signed out and in: the generation moved on.
  const again = owner(() => Promise.resolve(ISSUED));
  mounted = await mount(panel('delta:di@example.test:2', again.client));
  await mounted.click('[data-factor="enrol"] button');
  await settle();
  expect(again.sent(), 'sent before the earlier enrolment landed').toBe(0);
  for (const land of landed) land({ unavailable: true, because: 'gone' });
  await settle();
  expect(again.sent()).toBe(1);
  expect(mounted.text()).toContain('BRAVO-SECRET');
});

it('a step-up that keeps the grant key still waits, then sends on the new sign-in’s client', async () => {
  const landed: ((value: unknown) => void)[] = [];
  const before = owner(
    () =>
      new Promise((resolve) => {
        landed.push(resolve);
      }),
  );
  mounted = await mount(panel('echo:ed@example.test:0', before.client));
  await mounted.click('[data-factor="enrol"] button');
  await mounted.click('[data-factor="cancel"] button');
  // The step-up hands this panel, and a second one, the new sign-in's client.
  const after = owner(() => Promise.resolve(ISSUED));
  await mounted.render(panel('echo:ed@example.test:0', after.client));
  const other = await mount(panel('echo:ed@example.test:0', after.client));
  await other.click('[data-factor="enrol"] button');
  await settle();
  expect(after.sent(), 'sent before the earlier enrolment landed').toBe(0);
  for (const land of landed) land({ ok: true, value: { qrCode: '', secret: 'STALE-SECRET' } });
  await settle();
  expect(before.sent()).toBe(1);
  expect(after.sent()).toBe(1);
  expect(other.text()).toContain('BRAVO-SECRET');
  await mounted.click('[data-factor="enrol"] button');
  await settle();
  expect(after.sent()).toBe(2);
  expect(mounted.text()).toContain('BRAVO-SECRET');
  expect(mounted.text() + other.text()).not.toContain('STALE-SECRET');
});

it('two panels for one person send one enrolment at a time, and each draws only its own answer', async () => {
  const answers: ((value: unknown) => void)[] = [];
  const shared = owner(
    () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  );
  const left = await mount(panel('fox:fi@example.test:0', shared.client));
  const right = await mount(panel('fox:fi@example.test:0', shared.client));
  await left.click('[data-factor="enrol"] button');
  await right.click('[data-factor="enrol"] button');
  await settle();
  expect(shared.sent()).toBe(1);
  answers[0]?.({ ok: true, value: { qrCode: '', secret: 'LEFT-SECRET' } });
  await settle();
  expect(shared.sent()).toBe(2);
  answers[1]?.({ ok: true, value: { qrCode: '', secret: 'RIGHT-SECRET' } });
  await settle();
  expect(left.text()).toContain('LEFT-SECRET');
  expect(left.text()).not.toContain('RIGHT-SECRET');
  expect(right.text()).toContain('RIGHT-SECRET');
  expect(right.text()).not.toContain('LEFT-SECRET');
});
