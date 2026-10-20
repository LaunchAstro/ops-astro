// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1781: the correction card's Launch control says whether the business is in
// single-operator mode, from the `single_operator_mode` row `settings.read`
// answers, and says nothing of it when the read is refused. When the server
// refuses a Launch with `ASTRA_REVIEW_MISSING` (the first single-operator
// Launch has no Astra review of this version), Launch stays on the card,
// disabled, with that reason in plain words. The server is still the control:
// the card sends only `live_correction.decide`, and never `settings.*`.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import {
  ABOUT,
  CHECK_HOLDS_MS,
  V1,
  askFor,
  mockPropose,
  refusal,
} from './sidebar-corrections-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

interface Api {
  /** The mode `settings.read` answers, or 403 for a reader refused it. */
  readonly mode: boolean | 403;
  /** What `live_correction.decide` answers. */
  readonly decide: 'ok' | 'ASTRA_REVIEW_MISSING';
}

function alpha(api: Api) {
  const paths: string[] = [];
  const fetch = ((url: string | URL) => {
    const at = String(url);
    const path = at.slice(at.indexOf('/api/b/alpha') + '/api/b/alpha'.length);
    paths.push(path);
    if (path === '/settings/read') {
      if (api.mode === 403) return Promise.resolve(refusal('SCOPE_NOT_GRANTED', 403));
      const row = { key: 'single_operator_mode', value: api.mode, valueType: 'boolean' };
      return Promise.resolve(json({ ok: true, settings: [{ ...row, revision: 2 }] }));
    }
    if (path === '/live_correction/decide') {
      return Promise.resolve(
        api.decide === 'ok'
          ? json({ recordId: 'mock-correction-1', revision: 2, detail: {} })
          : refusal('ASTRA_REVIEW_MISSING', 409),
      );
    }
    return Promise.resolve(
      json({
        ok: true,
        correction: {
          correctionId: 'mock-correction-1',
          state: 'requested',
          approver: null,
          versionId: V1,
          verifiedAt: '2026-10-19T00:00:00.000Z',
          verifiedForMs: CHECK_HOLDS_MS,
          refusal: null,
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, paths };
}

async function drawn(api: Api) {
  const { client, paths } = alpha(api);
  const view = await mount(
    <SidebarCorrections client={client} propose={mockPropose().port} grantKey="alpha:ada:0" />,
  );
  await askFor(view, ABOUT);
  await tick();
  return { view, paths };
}

const modeLine = (view: Awaited<ReturnType<typeof drawn>>['view']): string | null =>
  view.find('[data-correction-card] [data-correction-single-operator]')?.textContent ?? null;

describe('the Launch control says the single-operator mode', () => {
  it('on, beside Launch', async () => {
    const { view } = await drawn({ mode: true, decide: 'ok' });
    expect(modeLine(view)).toMatch(/single-operator mode is on/iu);
  });

  it('off, beside Launch', async () => {
    const { view } = await drawn({ mode: false, decide: 'ok' });
    expect(modeLine(view)).toMatch(/single-operator mode is off/iu);
  });

  it('nothing, for a reader refused the settings read', async () => {
    const { view } = await drawn({ mode: 403, decide: 'ok' });
    expect(view.find('[data-correction-decide="approve"]')).not.toBeNull();
    expect(modeLine(view)).toBeNull();
  });
});

describe('a Launch refused for a missing Astra review', () => {
  it('stays disabled with that reason in plain words, and sends no setting', async () => {
    const { view, paths } = await drawn({ mode: true, decide: 'ASTRA_REVIEW_MISSING' });
    await view.click('[data-correction-decide="approve"]');
    await tick();
    const launch = view.find('[data-correction-decide="approve"]');
    expect(launch).toBeInstanceOf(HTMLButtonElement);
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    const reason = view.find('[data-correction-launch-held]')?.textContent ?? '';
    expect(reason).toMatch(/Astra/u);
    expect(reason).toMatch(/review/iu);
    expect(view.text()).not.toContain('ASTRA_REVIEW_MISSING');
    expect(paths.filter((path) => path.startsWith('/settings/set_'))).toStrictEqual([]);
  });

  it('a Launch the server takes leaves Launch as it was', async () => {
    const { view } = await drawn({ mode: true, decide: 'ok' });
    await view.click('[data-correction-decide="approve"]');
    await tick();
    expect(view.find('[data-correction-launch-held]')).toBeNull();
  });
});
