// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A promotion held for a fresh sign-in, when the read loses the last client
// it was for: the empty region withdraws it, so the check completing later
// resends nothing for a client no longer shown.

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { GraduationRegion } from '../../apps/web/src/screens/connections/graduation.tsx';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import type { ConnectionGraduationResult } from '../../packages/core-wire/src/index.ts';
import type { RollupFloor } from '../../apps/web/src/data/rollup-floor.ts';
import { mount } from './mount.tsx';
import { json, tick } from './graduation-draft-server.tsx';

// eslint-disable-next-line max-lines-per-function -- one pending check across the last client's removal
it('removing the last visible client withdraws its pending promotion step-up', async () => {
  let region: ConnectionGraduationResult = {
    ok: true,
    clients: [{ id: 'client-a', label: 'Client A', scopes: ['*', 'social.post'] }],
    mandates: [],
    rows: [
      {
        id: 'class-a',
        clientId: 'client-a',
        actionClass: 'social.post',
        classLabel: 'Posts',
        clearance: 'Draft',
        state: 'ready',
        heldBy: null,
        neverWhy: null,
        promotedAt: null,
        approved: 30,
        edited: 0,
        rejected: 0,
        since: '2026-09-01',
        note: '',
        revision: 1,
      },
    ],
  };
  const sent: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    await Promise.resolve();
    if (String(url).endsWith('/connection/graduation')) return json(region);
    expect(String(url)).toMatch(/\/graduation\/promote$/u);
    sent.push(JSON.parse(String(init?.body)));
    return sent.length === 1
      ? json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403)
      : json({ recordId: 'class-a', revision: 2, detail: { state: 'promoted' } });
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
  let finishCheck: ((value: { ok: true; sessionId: string }) => void) | undefined;
  const checking = new Promise<{ ok: true; sessionId: string }>((resolve) => {
    finishCheck = resolve;
  });
  const stepUp = async () => await checking;
  const screen = (client: OperationsClient) => (
    <StepUpContext.Provider value={stepUp}>
      <GraduationRegion client={client} grantKey="alpha:person-a" rollup={rollup} />
    </StepUpContext.Provider>
  );
  const makeClient = () =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(screen(makeClient()));
  await tick();
  await page.click('[data-auto]');
  await page.type('[data-promote-ceiling]', '500');
  await page.type('[data-promote-expiry]', '2030-10-31');
  await page.click('[data-promote-confirm]');
  await tick();
  expect(sent).toHaveLength(1);
  expect(page.find('[data-step-up="prompt"]')).not.toBeNull();
  await page.type('[data-step-up="code"]', '123456');
  await page.click('[data-step-up="confirm"]');
  expect(page.host.querySelector<HTMLButtonElement>('[data-step-up="confirm"]')?.disabled).toBe(
    true,
  );

  region = { ok: true, clients: [], rows: [], mandates: [] };
  await act(() => {
    for (const refresh of followers) refresh();
  });
  await tick();
  expect(page.find('[data-outcome="empty"]')).not.toBeNull();
  expect(page.find('[data-promote-form]')).toBeNull();
  expect(page.find('[data-step-up="prompt"]')).toBeNull();

  await act(() => {
    finishCheck?.({ ok: true, sessionId: 'fresh-session' });
  });
  await tick();
  await page.render(screen(makeClient()));
  await tick();
  expect(
    sent,
    'The removed client must not be promoted after its form and scope disappeared',
  ).toHaveLength(1);
});

it('a draft typed for the last client is not restored when that client comes back after an empty read', async () => {
  const shown: ConnectionGraduationResult = {
    ok: true,
    clients: [{ id: 'client-a', label: 'Client A', scopes: ['*'] }],
    mandates: [],
    rows: [],
  };
  let region = shown;
  const fetch: typeof globalThis.fetch = async (url) => {
    await Promise.resolve();
    expect(String(url)).toMatch(/\/connection\/graduation$/u);
    return json(region);
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
  const reread = async (next: ConnectionGraduationResult): Promise<void> => {
    region = next;
    await act(() => {
      for (const refresh of followers) refresh();
    });
    await tick();
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(
    <GraduationRegion client={client} grantKey="alpha:person-a" rollup={rollup} />,
  );
  await tick();
  await page.type('[data-mandate-label]', 'Approve posts');
  await reread({ ok: true, clients: [], rows: [], mandates: [] });
  expect(page.find('[data-outcome="empty"]')).not.toBeNull();
  await reread(shown);
  expect(page.host.querySelector<HTMLInputElement>('[data-mandate-label]')?.value).toBe('');
});
