// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1's shared stand-ins: a tab's storage, a mounted application that
// records every navigation, and the mockup's own route table read from the
// fixture copied out of the mockup repository (`routes.json`, version 1).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { ClientAccess } from '../../apps/web/src/manifest.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

export function storage(seed: Record<string, string> = {}): {
  readonly like: StorageLike;
  readonly held: Map<string, string>;
} {
  const held = new Map(Object.entries(seed));
  return {
    held,
    like: {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        held.set(key, value);
      },
      removeItem: (key) => {
        held.delete(key);
      },
    },
  };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Held open, so a built screen stays on `loading` and draws nothing it read. */
export const silent = (() =>
  new Promise<Response>(() => {
    /* never answers */
  })) as typeof globalThis.fetch;

export const session = (businessKey: string, token = `tok-${businessKey}`) => ({
  token,
  businessKey,
  email: `mia@${businessKey}.local`,
});

/** Made-up clients, one per business, each granted to that business's person only. */
export const GRANTS: Readonly<Record<string, readonly string[]>> = {
  alpha: ['acme-dental'],
  bravo: ['zenith-plumbing'],
};
export const granted: ClientAccess = (businessKey, client) =>
  GRANTS[businessKey]?.includes(client) ?? false;

export interface Opened {
  readonly view: Mounted;
  readonly seen: string[];
  readonly sessions: SessionStore;
  readonly held: Map<string, string>;
}

/** A fresh mount at `address`: the same thing a hard reload of it is. */
export async function open(
  address: string,
  options: {
    readonly businessKey?: string | null;
    readonly fetch?: typeof globalThis.fetch;
    readonly clientAccess?: ClientAccess;
    readonly seed?: Record<string, string>;
  } = {},
): Promise<Opened> {
  const businessKey = options.businessKey === undefined ? 'alpha' : options.businessKey;
  const seed =
    businessKey === null
      ? (options.seed ?? {})
      : { 'ops-astro.session': JSON.stringify(session(businessKey)), ...options.seed };
  const store = storage(seed);
  const sessions = new SessionStore(store.like);
  const seen: string[] = [];
  function Harness(): ReactElement {
    const [path, setPath] = useState(address);
    return (
      <App
        path={path}
        navigate={(next) => {
          seen.push(next);
          setPath(next);
        }}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={options.fetch ?? silent}
        storage={null}
        clientAccess={options.clientAccess ?? granted}
      />
    );
  }
  const view = await mount(<Harness />);
  return { view, seen, sessions, held: store.held };
}

interface MockupRoute {
  readonly path: string;
  readonly source?: string;
  readonly legacyHash?: string;
  readonly children?: readonly MockupRoute[];
}

interface MockupTable {
  readonly hub: readonly MockupRoute[];
  readonly clientWorkspace: readonly MockupRoute[];
  readonly clientPortal: readonly MockupRoute[];
  readonly utilityRoutes: readonly MockupRoute[];
}

export const MOCKUP = JSON.parse(
  readFileSync(resolve('tests/web/fixtures/mp-2-1-mockup-routes.json'), 'utf8'),
) as MockupTable;

/** Every address in the mockup's route table, sections and their children both. */
export function mockupAddresses(table: MockupTable = MOCKUP): readonly MockupRoute[] {
  const all = [...table.hub, ...table.clientWorkspace, ...table.clientPortal];
  return [...all, ...all.flatMap((route) => route.children ?? []), ...table.utilityRoutes];
}

export const normal = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

/** Fill `:client` with a made-up client slug. */
export const filled = (path: string, client = 'acme-dental'): string =>
  path.replace(':client', client);

export const LEGACY = /^\/(?:agency|client-portal)\//u;

export const hrefs = (view: Mounted): readonly string[] =>
  view.all('a[href]').map((anchor) => anchor.getAttribute('href') ?? '');

/** Let answered requests and the effects they trigger land. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((done) => {
        setTimeout(done, 0);
      });
    });
  }
}
