// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A standing approval filed while the region's read goes down: its typed form
// comes back with the region, and once the filing's own answer lands that form
// is cleared, so a second press of Add cannot file the same authority again.

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { GraduationRegion } from '../../apps/web/src/screens/connections/graduation.tsx';
import type { RollupFloor } from '../../apps/web/src/data/rollup-floor.ts';
import type {
  ConnectionGraduationResult,
  MandateView,
} from '../../packages/core-wire/src/index.ts';
import { mount } from './mount.tsx';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const reply = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

/**
 * File the one approval with its answer held, take the region down and up
 * again, and hand back the page with that filing still in flight.
 */
// eslint-disable-next-line max-lines-per-function -- the stub server and the steps, as written
async function fileAcrossAnOutage() {
  const region: ConnectionGraduationResult = {
    ok: true,
    clients: [{ id: 'client-a', label: 'Client A', scopes: ['*'] }],
    rows: [],
    mandates: [],
  };
  const followers = new Set<() => void>();
  const rollup: RollupFloor = {
    follow: (refresh) => {
      followers.add(refresh);
      return () => {
        followers.delete(refresh);
      };
    },
  };
  const gate: { release?: () => void } = {};
  const pending = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const filings: Record<string, unknown>[] = [];
  const stored = new Map<string, MandateView>();
  let outage = false;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/connection/graduation')) {
      if (outage) throw new TypeError('Failed to fetch');
      return reply({ ...region, mandates: [...stored.values()] });
    }
    if (String(url).endsWith('/mandate/file')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      filings.push(body);
      await pending;
      const operation = String(body['operationId']);
      if (!stored.has(operation)) {
        stored.set(operation, {
          id: `mandate-${stored.size + 1}`,
          clientId: 'client-a',
          classes: ['*'],
          refuses: false,
          ceiling: { amountMinor: 50_000, currency: 'AUD' },
          expiresAt: String(body['expiresAt']),
          expired: false,
          label: String(body['label']),
          graduationClass: null,
          authoredBy: 'person-a',
          createdAt: '2026-10-12T00:00:00Z',
          revision: 1,
        });
      }
      return reply({ recordId: stored.get(operation)?.id, revision: 1, detail: {} });
    }
    throw new Error(`Unexpected request ${String(url)}`);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(
    <GraduationRegion client={client} grantKey="alpha:person-a" rollup={rollup} />,
  );
  await tick();
  await page.type('[data-mandate-label]', 'Approve posts');
  await page.type('[data-mandate-ceiling]', '500');
  await page.type('[data-mandate-expiry]', '2030-10-31');
  await page.click('[data-mandate-add]');
  await tick();
  expect(filings).toHaveLength(1);

  outage = true;
  await act(() => {
    for (const refresh of followers) refresh();
  });
  await tick();
  expect(page.find('[data-outcome="unavailable"]')).not.toBeNull();
  outage = false;
  await page.click('[data-outcome="unavailable"] button');
  await tick();
  return { page, filings, release: () => gate.release?.() };
}

it('a filing in flight across an outage has its form restored', async () => {
  const { page } = await fileAcrossAnOutage();
  expect(page.host.querySelector<HTMLInputElement>('[data-mandate-label]')?.value).toBe(
    'Approve posts',
  );
});

it('a filing that succeeds after its form was restored cannot file duplicate authority', async () => {
  const { page, filings, release } = await fileAcrossAnOutage();
  expect(page.host.querySelector<HTMLInputElement>('[data-mandate-label]')?.value).toBe(
    'Approve posts',
  );

  release();
  await tick();
  expect(page.find('[data-mandate="mandate-1"]')?.textContent).toContain('Approve posts');
  expect(page.host.querySelector<HTMLButtonElement>('[data-mandate-add]')?.disabled).toBe(false);
  await page.click('[data-mandate-add]');
  await tick();
  expect(
    new Set(filings.map((body) => body['operationId'])).size,
    'A successful filing must clear the restored form before Add can create another mandate',
  ).toBe(1);
});
