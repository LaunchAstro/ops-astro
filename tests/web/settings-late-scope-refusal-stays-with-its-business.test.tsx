// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Criterion 2: Alpha's late SCOPE_NOT_GRANTED on a
// settings write must not close Bravo's controls in the same mounted screen.
//
// Ada saves a threshold in Alpha and the answer is held. The tab and the
// still-mounted screen move to Bravo, where Ada holds spend:decide and both
// reads answer. Alpha's write is then refused. That refusal is Alpha's: Bravo's
// screen should show no refusal, no closed banner, and a Save that still sends.

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test' };
const BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test' };

interface Business {
  readonly fetch: typeof globalThis.fetch;
  /** Answers the held threshold write with this response. */
  readonly answer: (response: Response) => void;
  readonly writes: () => number;
}

/** One business's API: reads answer at once, the threshold write waits for `answer`. */
function business(key: string, value: number): Business {
  let writes = 0;
  const gate: { release: ((response: Response) => void) | null } = { release: null };
  const held = new Promise<Response>((resolve) => {
    gate.release = resolve;
  });
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (!at.includes(`/api/b/${key}/`)) throw new Error(`${key} client sent ${at}`);
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: key,
        grants: [
          { collection: 'settings', action: 'manage' },
          { collection: 'settings', action: 'read' },
          { collection: 'spend', action: 'decide' },
        ],
      });
    }
    if (at.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [
          {
            key: 'four_eyes_threshold',
            value,
            valueType: 'number',
            updatedAt: '2026-10-01T00:00:00.000Z',
            updatedByActorId: 'actor-ada',
          },
        ],
      });
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      writes += 1;
      if (key === 'alpha') return await held;
      return json({ recordId: 'row', revision: null, detail: { value: 9000 } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    answer: (response) => {
      gate.release?.(response);
    },
    writes: () => writes,
  };
}

const screen = (session: Session, api: Business) => (
  <SettingsScreen
    client={
      new OperationsClient({
        origin: '',
        businessKey: session.businessKey,
        signedIn: true,
        fetch: api.fetch,
      })
    }
    grantKey={grantKeyOf(session)}
    storage={window.sessionStorage}
  />
);

describe('a settings refusal stays with its business', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("Alpha's late refusal leaves Bravo's settings controls open", async () => {
    const sessions = new SessionStore(window.sessionStorage);
    const alpha = business('alpha', 500);
    const bravo = business('bravo', 800);

    // Save a threshold in Alpha; its answer is held.
    sessions.set(ALPHA);
    const page = await mount(screen(ALPHA, alpha));
    await tick();
    await page.type('#settings-four-eyes', '7777');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(alpha.writes()).toBe(1);

    // Switch the tab and the same screen to Bravo, and finish Bravo's reads.
    sessions.set(BRAVO);
    await page.render(screen(BRAVO, bravo));
    await tick();
    expect(page.find('[data-screen="settings"]')?.getAttribute('data-business')).toBe('bravo');
    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('ready');

    // Alpha refuses the write it was sent, now that the screen is Bravo's.
    alpha.answer(
      json(
        {
          refused: true,
          code: 'SCOPE_NOT_GRANTED',
          names: ['spend:decide'],
          fixes: ['Ask an owner of alpha for spend:decide.'],
        },
        403,
      ),
    );
    await tick();

    const seen = {
      refusal: page.find('[data-settings="refusal"]')?.textContent ?? null,
      closedBanner: page.find('[data-settings="closed"]') !== null,
      saveDisabled: (page.find('[data-settings="save-four-eyes"]') as HTMLButtonElement | null)
        ?.disabled,
    };

    // Attempt a Bravo save.
    await page.type('#settings-four-eyes', '9000');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect({ ...seen, bravoWrites: bravo.writes() }).toEqual({
      refusal: null,
      closedBanner: false,
      saveDisabled: false,
      bravoWrites: 1,
    });
  });
});
