// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C41-A's look (U38, #495): an onboarding laid out as tasks in phases, built
// from the kit with no private style. There is no onboarding read yet (the
// commands are `onboarding.start` and `onboarding.step_result`), so the page
// draws a made-up onboarding inside the kit's one mock label (DS-PRIM-32)
// behind the same shape the step rows have. The commands' own cases are
// `tests/onboarding/c41-a-onboarding.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { OnboardingScreen } from '../../apps/web/src/screens/Onboarding.tsx';
import { MADE_UP_ONBOARDING } from '../../apps/web/src/screens/onboarding/made-up.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { mount, type Mounted } from './mount.tsx';

const opened: Mounted[] = [];

async function open(): Promise<{ readonly page: Mounted; readonly sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((url: string | URL) => {
    sent.push(String(url));
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<OnboardingScreen client={client} />);
  opened.push(page);
  return { page, sent };
}

afterEach(async () => {
  for (const page of opened.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one page at a time
    if (page.host.isConnected) await page.unmount();
  }
});

const text = (page: Mounted, selector: string): string => page.all(selector)[0]?.textContent ?? '';

/** An element's data attributes, read through the DOM's own map. */
const data = (element: Element | null | undefined): DOMStringMap =>
  element instanceof HTMLElement ? element.dataset : {};

describe('C41-A onboarding look', () => {
  it('C41-A phases and dependencies: each step in its phase, marked agent-run, needs a person or waits on the client, with what it waits for', async () => {
    const { page } = await open();
    const phases = page
      .all('[data-onboarding-phase]')
      .map((phase) => data(phase)['onboardingPhase']);
    expect(phases).toEqual([...new Set(MADE_UP_ONBOARDING.steps.map((step) => step.phase))]);
    for (const step of MADE_UP_ONBOARDING.steps) {
      const row = page.find(`[data-step="${step.key}"]`);
      expect(data(row?.closest('[data-onboarding-phase]'))['onboardingPhase']).toBe(step.phase);
      expect(row?.querySelector('[data-step-kind]')?.textContent).toBe(
        { agent: 'Agent runs it', person: 'Needs a person', client: 'Waits on the client' }[
          step.kind
        ],
      );
      for (const before of step.dependsOn) {
        expect(row?.querySelector('[data-step-after]')?.textContent).toContain(
          MADE_UP_ONBOARDING.steps.find((each) => each.key === before)?.title,
        );
      }
    }
  });

  it('C41-A step result on its task: a finished step shows its result, a parked one says whose move it is', async () => {
    const { page } = await open();
    const done = MADE_UP_ONBOARDING.steps.find((step) => step.state === 'done');
    expect(text(page, `[data-step="${done?.key ?? ''}"] [data-step-result]`)).toBe(done?.result);
    const parked = MADE_UP_ONBOARDING.steps.find(
      (step) => step.state === 'ready' && step.kind === 'person',
    );
    expect(text(page, `[data-step="${parked?.key ?? ''}"] [data-step-state]`)).toContain('Parked');
  });

  it('C41-A onboarding look: every made-up value sits inside the one mock label, and the page reads and sends nothing', async () => {
    const { page, sent } = await open();
    const mock = page.find('[data-onboarding] .is-mock');
    expect(mock?.querySelector('.mocktag')?.textContent).toBe('Mock');
    for (const step of page.all('[data-step]')) expect(mock?.contains(step)).toBe(true);
    expect(mock?.textContent).toContain(MADE_UP_ONBOARDING.client);
    // Started from the command palette or the CLI; the page places no button.
    expect(page.find('[data-onboarding] button')).toBeNull();
    expect(sent).toEqual([]);
    expect(matchRoute('/onboarding/')?.id).toBe('agency:onboarding');
  });
});
