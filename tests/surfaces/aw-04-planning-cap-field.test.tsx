// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning cap field` (owner, NATHAN-STAGE1-TODAY 4): the settings page
// shows the AI planning chat's budget, AUD 50 per business until someone moves
// it, and the owner or an administrator (`billing:decide`) changes it there
// through `budget.set_planning_cap`, against the limit the page read. Anyone
// else reads it with the control closed and the reason on the page.

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < 4; turn += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Options {
  /** The grants `session.capabilities` answers. */
  readonly grants: readonly { readonly collection: string; readonly action: string }[];
  /** Answer the first write stale, as when somebody else moved the cap first. */
  readonly staleOnce?: boolean;
}

/** The API the page meets: a cap that starts at the default and moves when written. */
function server(options: Options) {
  const sent: { readonly at: string; readonly body: Record<string, unknown> }[] = [];
  let cap = { limitMinor: 5_000, currency: 'AUD', set: false };
  let stale = options.staleOnce === true;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    if (at.endsWith('/settings/read')) {
      return Promise.resolve(json({ ok: true, settings: [], planningCap: cap }));
    }
    if (at.endsWith('/session/capabilities')) {
      return Promise.resolve(
        json({ ok: true, personId: 'p-ada', businessKey: 'alpha', grants: options.grants }),
      );
    }
    if (at.endsWith('/budget/set_planning_cap')) {
      if (stale) {
        stale = false;
        cap = { limitMinor: 6_000, currency: 'AUD', set: true };
        return Promise.resolve(
          json(
            {
              refused: true,
              code: 'VERSION_STALE',
              names: ['limitMinor=6000'],
              fixes: ['The planning cap has moved since you last saw it.'],
            },
            409,
          ),
        );
      }
      cap = { limitMinor: Number(body['limitMinor']), currency: 'AUD', set: true };
      return Promise.resolve(
        json({ recordId: 'cap-row', revision: null, detail: { key: 'planning', ...cap } }),
      );
    }
    return Promise.reject(new Error(`unrouted ${at}`));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const screen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen
    client={new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch })}
    grantKey="alpha:ada"
    storage={window.sessionStorage}
  />
);

const writes = (api: ReturnType<typeof server>) =>
  api.sent.filter((call) => call.at.endsWith('/budget/set_planning_cap'));

async function typeInto(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector) as HTMLInputElement | null;
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const BILLING = { collection: 'billing', action: 'decide' };

describe('AW-04 planning cap field', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('AW-04 planning cap field: the page shows the default AUD 50, and a billing holder moves it from the limit it read', async () => {
    const api = server({ grants: [BILLING] });
    const page = await mount(screen(api.fetch));
    await tick();

    const shown = page.find('[data-settings="planning-cap-known"]')?.textContent ?? '';
    expect(shown).toContain('AUD 50.00');
    expect(shown).toContain('default');
    await typeInto(page.host, '#settings-planning-cap', '75');
    await page.click('[data-settings="save-planning-cap"]');
    await tick();

    const sent = writes(api);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.at).toContain('/b/alpha/budget/set_planning_cap');
    expect(sent[0]?.body).toMatchObject({
      limitMinor: 7_500,
      currency: 'AUD',
      fromLimitMinor: 5_000,
    });
    expect(page.find('[data-settings="planning-cap-known"]')?.textContent).toContain('AUD 75.00');
    await page.unmount();
  });

  it('AW-04 planning cap field: a cap somebody else moved first is refused, reread and shown, and nothing is sent again unasked', async () => {
    const api = server({ grants: [BILLING], staleOnce: true });
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#settings-planning-cap', '75');
    await page.click('[data-settings="save-planning-cap"]');
    await tick();

    expect(writes(api)).toHaveLength(1);
    expect(page.find('[data-settings="planning-cap-refusal"]')?.textContent).toContain(
      'The planning cap has moved since you last saw it.',
    );
    expect(page.find('[data-settings="planning-cap-known"]')?.textContent).toContain('AUD 60.00');
    // The next press is against what the page now shows.
    await page.click('[data-settings="save-planning-cap"]');
    await tick();
    expect(writes(api)[1]?.body).toMatchObject({ limitMinor: 7_500, fromLimitMinor: 6_000 });
    await page.unmount();
  });

  it('AW-04 planning cap field: without billing:decide the value reads and the control is closed, with the reason, and nothing is sent', async () => {
    const api = server({ grants: [{ collection: 'settings', action: 'read' }] });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="planning-cap-known"]')?.textContent).toContain('AUD 50.00');
    const field = page.find('#settings-planning-cap') as HTMLInputElement | null;
    const save = page.find('[data-settings="save-planning-cap"]') as HTMLButtonElement | null;
    expect(field?.disabled).toBe(true);
    expect(save?.disabled).toBe(true);
    expect(page.find('[data-settings="planning-cap-closed"]')?.textContent).toContain(
      'owner or an administrator',
    );
    await page.click('[data-settings="save-planning-cap"]');
    await tick();
    expect(writes(api)).toHaveLength(0);
    await page.unmount();
  });

  it('AW-04 planning cap field: an amount that is not whole cents above zero is named on the page and never sent', async () => {
    const api = server({ grants: [BILLING] });
    const page = await mount(screen(api.fetch));
    await tick();

    for (const typed of ['', '0', '-5', '12.345', 'fifty']) {
      // eslint-disable-next-line no-await-in-loop
      await typeInto(page.host, '#settings-planning-cap', typed);
      // eslint-disable-next-line no-await-in-loop
      await page.click('[data-settings="save-planning-cap"]');
      // eslint-disable-next-line no-await-in-loop
      await tick();
      expect(page.find('[data-settings="planning-cap-refusal"]')?.textContent).toContain('dollars');
    }
    expect(writes(api)).toHaveLength(0);
    await page.unmount();
  });
});
