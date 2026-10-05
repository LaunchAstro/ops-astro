// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Criterion 2: Alpha's threshold save,
// refused STEP_UP_REQUIRED after the still-mounted Settings screen moved to
// Bravo, must open no prompt in Bravo and send nothing to Bravo.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpProviders } from '../../apps/web/src/records/step-up-providers.tsx';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import type { StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { mount } from '../surfaces/mount.tsx';
import { tick } from '../surfaces/settings-four-eyes-world.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CAPABILITIES = {
  ok: true,
  personId: 'p-ada',
  grants: [
    { collection: 'settings', action: 'manage' },
    { collection: 'spend', action: 'decide' },
  ],
};

interface Business {
  readonly row: { value: unknown; revision: number };
  readonly writes: Record<string, unknown>[];
  /** Holds the next write's answer until the test releases it. */
  hold: ((answer: Response) => void) | null;
  holdNext: boolean;
}

/** One business's API: its four-eyes row, the writes it received, and an optional held write. */
function business(businessKey: string, value: number, revision: number) {
  const state: Business = { row: { value, revision }, writes: [], hold: null, holdNext: false };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/session/capabilities'))
      return Promise.resolve(json({ ...CAPABILITIES, businessKey }));
    if (at.endsWith('/settings/read')) {
      return Promise.resolve(
        json({
          ok: true,
          settings: [
            {
              key: 'four_eyes_threshold',
              value: state.row.value,
              valueType: 'number',
              updatedAt: '2026-10-05T02:15:00.000Z',
              updatedByActorId: 'actor-bo',
              revision: state.row.revision,
            },
          ],
        }),
      );
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      state.writes.push(body);
      if (state.holdNext) {
        state.holdNext = false;
        return new Promise<Response>((resolve) => {
          state.hold = resolve;
        });
      }
      if (
        body['expectedRevision'] !== undefined &&
        body['expectedRevision'] !== state.row.revision
      ) {
        return Promise.resolve(
          json(
            { refused: true, code: 'VERSION_STALE', names: ['four_eyes_threshold'], fixes: [] },
            409,
          ),
        );
      }
      state.row.value = body['value'];
      state.row.revision += 1;
      return Promise.resolve(
        json({ recordId: 'row', revision: state.row.revision, detail: { ...state.row } }),
      );
    }
    if (at.endsWith('/account/sessions/list')) return Promise.resolve(json({ sessions: [] }));
    return Promise.resolve(json({}));
  }) as unknown as typeof globalThis.fetch;
  const client = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  return { state, client };
}

it('a late Alpha step-up refusal opens no prompt and sends nothing to Bravo', async () => {
  window.sessionStorage.clear();
  const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
  const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };
  const alpha = business('alpha', 500, 7);
  const bravo = business('bravo', 900, 7);
  const alphaClient = alpha.client();
  const bravoClient = bravo.client();
  const refreshedBravo = bravo.client();
  const sessions = new SessionStore(window.sessionStorage);

  const codes: string[] = [];
  const stepUp = (code: string): Promise<StepUpResult> => {
    codes.push(code);
    return Promise.resolve({ ok: true, sessionId: 'bravo-stepped-up' });
  };
  const signInAgain = (): Promise<StepUpResult> =>
    Promise.resolve({ ok: false, because: 'not used' });
  const page = (client: OperationsClient, grantKey: string) => (
    <StepUpProviders on stepUp={stepUp} signInAgain={signInAgain}>
      <SettingsScreen client={client} grantKey={grantKey} storage={window.sessionStorage} />
    </StepUpProviders>
  );

  // Open Alpha settings; turn the four-eyes band off and press Save (held).
  sessions.set(ALPHA);
  const view = await mount(page(alphaClient, grantKeyOf(ALPHA)));
  try {
    await tick();
    alpha.state.holdNext = true;
    await view.click('#settings-four-eyes-off');
    await view.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(alpha.state.writes).toHaveLength(1);
    expect(alpha.state.hold).not.toBeNull();

    // Switch the tab to Bravo; the same SettingsScreen renders Bravo's client and grant.
    sessions.set(BRAVO);
    const bravoGrant = grantKeyOf(BRAVO);
    await view.render(page(bravoClient, bravoGrant));
    await tick();

    // Alpha's held write answers late: STEP_UP_REQUIRED.
    alpha.state.hold?.(
      json(
        { refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: ['Confirm with your code.'] },
        403,
      ),
    );
    await tick();
    const promptOpenedInBravo = view.find('[data-step-up="prompt"]') !== null;

    // Complete the prompt shown in Bravo with a valid code, then render refreshed Bravo.
    if (promptOpenedInBravo) {
      await view.type('[data-step-up="code"]', '123456');
      await view.click('[data-step-up="confirm"]');
      await tick();
    }
    await view.render(page(refreshedBravo, bravoGrant));
    await tick();

    expect({
      promptOpenedInBravo,
      bravoWrites: bravo.state.writes,
      bravoThreshold: bravo.state.row.value,
    }).toEqual({ promptOpenedInBravo: false, bravoWrites: [], bravoThreshold: 900 });
  } finally {
    await view.unmount();
  }
});
