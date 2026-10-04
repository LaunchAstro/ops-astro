// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { drawScreen } from '../../apps/web/src/screen-registry.tsx';
import { matchRoute } from '../../apps/web/src/routes.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const route = matchRoute('/settings');
if (route?.id !== 'agency:settings') throw new Error('settings route absent');
const settings = route;

// Sol F2-FIX1 criterion 2, retitled by what it proves; its body is Sol's.
it.each([
  ['business to business', 'bravo', 'bravo:ada'],
  ['person to person', 'alpha', 'alpha:ben'],
])(
  '%s authenticator removal drops the previous reader code',
  async (_boundary, business, grant) => {
    const writes: string[] = [];
    const network: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith('/account/factor/remove')) {
        writes.push(
          `${url} ${new Headers(init?.headers).get('x-ops-astro-session')} ${String(init?.body)}`,
        );
        return Promise.resolve(Response.json({ removed: true }));
      }
      return Promise.resolve(
        Response.json({ preferences: {}, settings: [], grants: [], sessions: [] }),
      );
    };
    const client = (businessKey: string, sessionId: string) =>
      new OperationsClient({ origin: '', businessKey, sessionId, signedIn: true, fetch: network });
    const draw = (source: OperationsClient, grantKey: string) => (
      <StepUpContext.Provider value={() => Promise.resolve({ ok: false, because: 'not used' })}>
        {drawScreen(settings, {
          client: source,
          grantKey,
          notice: null,
          storage: null,
          navigate: () => {},
        })}
      </StepUpContext.Provider>
    );
    const page = await mount(draw(client('alpha', 'ada-session'), 'alpha:ada'));
    try {
      await settle();
      await page.click('[data-factor="remove"] button');
      await page.type('[data-factor="remove-code"]', '123456');
      await page.render(
        draw(client(business, grant === 'alpha:ben' ? 'ben-session' : 'ada-session'), grant),
      );
      const previousCode = (page.find('[data-factor="remove-code"]') as HTMLInputElement | null)
        ?.value;
      if (page.find('[data-factor="remove-confirm"] button') !== null)
        await page.click('[data-factor="remove-confirm"] button');
      await settle();
      expect(
        { previousCode, writes },
        'the new owner retains and submits the old owner authenticator code',
      ).toEqual({ previousCode: undefined, writes: [] });
    } finally {
      await page.unmount();
    }
  },
);
