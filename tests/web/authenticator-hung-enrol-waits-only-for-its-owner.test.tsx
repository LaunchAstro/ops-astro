// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An enrolment that never answers holds back only the same person's next
// enrolment in that business, which it could still replace when it lands. A
// different owner's set-up sends at once.

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
