// SPDX-License-Identifier: AGPL-3.0-only
//
// The stand-in world Settings ▸ Access is drawn in by the C32 and C58 screen
// cases: one business, two client records, a teammate with no permission, a
// client on a share and an agent on a live delegation, in the shapes
// `access.read` answers (`tests/reads/effective-permissions.test.ts` pins them
// on the real server). The API is a stub that records every call.

import { expect } from 'vitest';
import type { ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

export const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };

export const ACME = { clientId: 'c-acme', name: 'Acme Dental' };
export const BOLT = { clientId: 'c-bolt', name: 'Bolt Physio' };

export const ADA = {
  personId: 'p-ada',
  name: 'Ada Alpha',
  permissions: [{ collection: 'access', action: 'manage', scope: { kind: 'business', id: null } }],
  grants: [
    {
      grantId: 'g-ada-access',
      collection: 'access',
      action: 'manage',
      scope: { kind: 'business', id: null },
    },
  ],
};
export const MIA = { personId: 'p-mia', name: 'Mia Alpha', permissions: [], grants: [] };
export const CLEO = {
  personId: 'p-cleo',
  name: 'Cleo Client',
  permissions: [
    { collection: 'task', action: 'read', scope: { kind: 'party', id: ACME.clientId } },
  ],
  grants: [],
};
export const AGENT = {
  agentActorId: 'a-1',
  delegationId: 'd-1',
  purpose: 'Draft the weekly report',
  person: { personId: ADA.personId, name: ADA.name },
  expiresAt: '2026-10-01T00:00:00.000Z',
  permissions: [{ collection: 'task', action: 'write', scope: { kind: 'record', id: 't-1' } }],
};

export const MIA_ON_ACME = {
  ...MIA,
  permissions: [
    { collection: 'task', action: 'read', scope: { kind: 'party', id: ACME.clientId } },
  ],
};

export const access = (team: readonly unknown[], agents: readonly unknown[] = [AGENT]) => ({
  ok: true,
  team,
  clients: [CLEO],
  agents,
  clientRecords: [ACME, BOLT],
});

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [], fixes: [] }, status);

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A stand-in API: `reads` answers `access.read` in turn (the last one repeats), `write` every command. */
export function server(
  reads: readonly Response[],
  write: () => Response = () => json({ recordId: 'r', revision: 1 }),
) {
  const calls: Call[] = [];
  let read = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    calls.push({
      url: at,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (at.endsWith('/access/read')) {
      const answer = reads[Math.min(read, reads.length - 1)];
      read += 1;
      return Promise.resolve(answer?.clone() ?? refusal('NOT_FOUND', 404));
    }
    return Promise.resolve(write());
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    commands: () => calls.filter((call) => !call.url.endsWith('/access/read')),
  };
}

/** Mounted views, unmounted after each case whether it passed or not. */
export const live: Mounted[] = [];
export const unmountAll = async (): Promise<void> => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
};

export async function open(
  fetch: typeof globalThis.fetch,
  path = '/settings/access/',
): Promise<Mounted> {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  const sessions = new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
  const element: ReactElement = (
    <App
      path={path}
      navigate={() => {
        // One address for the whole case.
      }}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />
  );
  const view = await mount(element);
  live.push(view);
  await settle();
  await settle();
  return view;
}

export const rowOf = (view: Mounted, personId: string): string =>
  view.find(`[data-person="${personId}"]`)?.closest('tr')?.textContent ?? '';

/** Choose an option of a kit select by its label, the way a person does. */
export async function choose(view: Mounted, field: string, label: string): Promise<void> {
  await view.click(`[data-field="${field}"] button.sel__btn`);
  const option = view
    .all(`[data-field="${field}"] [role="option"]`)
    .find((each) => each.textContent === label);
  expect(option, `${field}: ${label}`).toBeDefined();
  await view.click(`#${option?.id ?? ''}`);
}
