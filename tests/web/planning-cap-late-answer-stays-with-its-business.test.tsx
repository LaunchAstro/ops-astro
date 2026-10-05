// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The planning cap is money (billing:decide) and each business's own. Ada
// saves Alpha's cap and the answer is held while the tab, and the
// still-mounted Settings screen, move to Bravo. Alpha's late answer is
// Alpha's: a step-up refusal opens no prompt in Bravo and sends nothing
// through Bravo's sign-in, and a scope refusal neither speaks in Bravo nor
// closes Bravo's cap control.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpProviders } from '../../apps/web/src/records/step-up-providers.tsx';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import type { StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { tick } from '../surfaces/settings-four-eyes-world.tsx';

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signInAgain = (): Promise<StepUpResult> =>
  Promise.resolve({ ok: false, because: 'not used' });
const stepUp = (): Promise<StepUpResult> =>
  Promise.resolve({ ok: true, sessionId: 'bravo-stepped-up' });

/** One business's API: its planning cap, the cap writes it was sent, and the first one held. */
function business(businessKey: string) {
  const state = { limitMinor: 5000, writes: [] as Record<string, unknown>[] };
  const gate: { answer: ((response: Response) => void) | null } = { answer: null };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (!at.includes(`/api/b/${businessKey}/`)) throw new Error(`${businessKey} client sent ${at}`);
    if (at.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({
          ok: true,
          personId: 'p-ada',
          businessKey,
          grants: [
            { collection: 'settings', action: 'manage' },
            { collection: 'billing', action: 'decide' },
          ],
        }),
      );
    }
    if (at.endsWith('/settings/read')) {
      const planningCap = { limitMinor: state.limitMinor, currency: 'AUD', set: false };
      return Promise.resolve(json({ ok: true, settings: [], planningCap }));
    }
    if (at.endsWith('/budget/set_planning_cap')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      state.writes.push(body);
      if (businessKey === 'alpha' && state.writes.length === 1) {
        return new Promise<Response>((resolve) => {
          gate.answer = resolve;
        });
      }
      state.limitMinor = Number(body['limitMinor']);
      return Promise.resolve(json({ recordId: 'cap', revision: 1, detail: {} }));
    }
    return Promise.resolve(json({ sessions: [] }));
  }) as unknown as typeof globalThis.fetch;
  const client = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  return { state, gate, client };
}

const page = (client: OperationsClient, session: Session, up = stepUp) => (
  <StepUpProviders on stepUp={up} signInAgain={signInAgain}>
    <SettingsScreen
      client={client}
      grantKey={grantKeyOf(session)}
      storage={window.sessionStorage}
    />
  </StepUpProviders>
);

/** Alpha's cap save held, then the tab and the same screen on Bravo with its reads answered. */
async function heldInAlphaThenBravo(): Promise<{
  view: Mounted;
  alpha: ReturnType<typeof business>;
  bravo: ReturnType<typeof business>;
}> {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const alpha = business('alpha');
  const bravo = business('bravo');
  sessions.set(ALPHA);
  const view = await mount(page(alpha.client(), ALPHA));
  await tick();
  await view.type('#settings-planning-cap', '9999');
  await view.click('[data-settings="save-planning-cap"]');
  await tick();
  expect(alpha.gate.answer, "Alpha's cap save was not sent").not.toBeNull();
  sessions.set(BRAVO);
  await view.render(page(bravo.client(), BRAVO));
  await tick();
  return { view, alpha, bravo };
}

it("a late Alpha step-up refusal opens no prompt and sends nothing to Bravo's cap", async () => {
  const { view, alpha, bravo } = await heldInAlphaThenBravo();
  try {
    const refusal = { refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: ['Code.'] };
    alpha.gate.answer?.(json(refusal, 403));
    await tick();
    const promptOpenedInBravo = view.find('[data-step-up="prompt"]') !== null;
    if (promptOpenedInBravo) {
      await view.type('[data-step-up="code"]', '123456');
      await view.click('[data-step-up="confirm"]');
      await tick();
    }
    await view.render(page(bravo.client(), BRAVO));
    await tick();
    expect({
      promptOpenedInBravo,
      writes: bravo.state.writes,
      cap: bravo.state.limitMinor,
    }).toEqual({ promptOpenedInBravo: false, writes: [], cap: 5000 });
  } finally {
    await view.unmount();
  }
});

it("Alpha's late scope refusal neither speaks in Bravo nor closes Bravo's cap control", async () => {
  const { view, alpha, bravo } = await heldInAlphaThenBravo();
  try {
    const refusal = {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: ['billing:decide'],
      fixes: ['Ask an owner of alpha.'],
    };
    alpha.gate.answer?.(json(refusal, 403));
    await tick();
    const save = view.find('[data-settings="save-planning-cap"]') as HTMLButtonElement | null;
    const seen = {
      refusal: view.find('[data-settings="planning-cap-refusal"]')?.textContent ?? null,
      disabled: save?.disabled,
    };
    await view.type('#settings-planning-cap', '60');
    await view.click('[data-settings="save-planning-cap"]');
    await tick();
    expect({ ...seen, cap: bravo.state.limitMinor }).toEqual({
      refusal: null,
      disabled: false,
      cap: 6000,
    });
  } finally {
    await view.unmount();
  }
});

it("Ada's cap step-up passing after the tab moved to Ben sends nothing through Ben's sign-in", async () => {
  window.sessionStorage.clear();
  const sessions = new SessionStore(window.sessionStorage);
  const BEN: Session = { businessKey: 'alpha', email: 'ben@example.test' };
  const ada = business('alpha');
  const ben = business('alpha');
  const check: { pass: ((result: StepUpResult) => void) | null } = { pass: null };
  const held = (): Promise<StepUpResult> =>
    new Promise((resolve) => {
      check.pass = resolve;
    });
  sessions.set(ALPHA);
  const view = await mount(page(ada.client(), ALPHA, held));
  try {
    await tick();
    await view.type('#settings-planning-cap', '9999');
    await view.click('[data-settings="save-planning-cap"]');
    await tick();
    const refusal = { refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: ['Code.'] };
    ada.gate.answer?.(json(refusal, 403));
    await tick();
    await view.type('[data-step-up="code"]', '123456');
    await view.click('[data-step-up="confirm"]');
    await tick();
    expect(check.pass, "Ada's code is not being checked").not.toBeNull();

    // While the code is checked, the tab and the same screen move to Ben.
    sessions.set(BEN);
    await view.render(page(ben.client(), BEN, held));
    await tick();
    check.pass?.({ ok: true, sessionId: 'ada-stepped-up' });
    await tick();
    expect({ ben: ben.state.writes, cap: ben.state.limitMinor }).toEqual({ ben: [], cap: 5000 });
  } finally {
    await view.unmount();
  }
});
