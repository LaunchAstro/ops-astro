// SPDX-License-Identifier: AGPL-3.0-only
//
// Doubles for the proxy-state tests: a daemon that holds the containers it
// made and answers each call as a test sets it, a store that can die between
// the daemon's create and the proxy's write, a pin list, and a clock. Every
// case runs against these doubles; the real daemon's crossings are CI's.

import {
  admitCandidateLoad,
  type Candidate,
  type CandidateBook,
  EMPTY_BOOK,
} from '../../packages/core-sandbox/src/candidate-book.ts';
import {
  type ContainerBook,
  EMPTY_CONTAINERS,
} from '../../packages/core-sandbox/src/container-book.ts';
import type { CreateShape } from '../../packages/core-sandbox/src/create-body.ts';
import type { SiteEntry } from '../../packages/core-sandbox/src/pin-list.ts';
import {
  type ProxyPorts,
  type ProxyRecord,
  ProxyState,
  readProxyRecord,
  type StateOp,
  writeProxyRecord,
} from '../../packages/core-sandbox/src/proxy-state.ts';
import { S1_OPENING, S2_OPENING } from '../../packages/core-sandbox/src/run-env.ts';

export const image = (c: string): string => `sha256:${c.repeat(64)}`;
/** Site p's accepted image, site s's candidate, the base and the probe. */
export const P: string = image('a');
export const C: string = image('c');
export const BASE: string = image('b');
export const PROBE: string = image('f');
const LOCK = image('1');
export const T0: number = 1_000_000;
/** S1's wall clock (B6) and P4 and P6's 30 s. */
export const S1_WALL: number = 120_000;
export const GRACE: number = 30_000;

export const env = (site: string): string[] => [...S1_OPENING, `PUBLIC_SITE=${site}`];
export const making = (attempt = 1): SiteEntry => ({
  lockfile: LOCK,
  image: '',
  attempt,
  commit: 'e'.repeat(40),
  env: env('s'),
});
export const pinnedEntry = (id: string, site: string, attempt = 1): SiteEntry => ({
  lockfile: LOCK,
  image: id,
  attempt,
  commit: '',
  env: env(site),
});
/** Site p pinned to P (accepted) and site s making its pin. */
export const SITES: Record<string, SiteEntry> = { p: pinnedEntry(P, 'p'), s: making() };

export function pinList(sites: Record<string, SiteEntry> = SITES): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      probe: { image: PROBE },
      base: { 'linux/amd64': { image: BASE, env: S2_OPENING } },
      sites,
    }),
  );
}

/** P accepted for site p, and C loaded as site s's candidate. */
export function seededBook(sites: Record<string, SiteEntry> = SITES): CandidateBook {
  const load = admitCandidateLoad(EMPTY_BOOK, new Map(Object.entries(sites)), 's', C);
  if (!load.ok) throw new Error('load refused');
  return { ...load.book, accepted: [{ site: 'p', id: P, lockfile: LOCK, attempt: 1 }] };
}
export const seeded = (containers: ContainerBook = EMPTY_CONTAINERS): Uint8Array =>
  writeProxyRecord({ candidates: seededBook(), containers });

export const s1 = (site: string): CreateShape => ({ runClass: 'site.build', env: env(site) });
export const S2: CreateShape = { runClass: 'site.prepare', env: S2_OPENING };
export const create = (id: string, shape: CreateShape = s1('s')): StateOp => ({
  kind: 'create',
  shape,
  image: id,
});
export const op = (
  kind: 'start' | 'wait' | 'kill' | 'delete' | 'inspect',
  id: string,
): StateOp => ({
  kind,
  id,
});
export const refused = (why: string): object => ({ ok: false, reason: 'proxy refused', why });
export const UNAVAILABLE: object = { ok: false, reason: 'unavailable', why: 'sweep' };

type Reply = { readonly status: number; readonly body: Uint8Array };
const reply = (status: number, value?: unknown): Reply => ({
  status,
  body: value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(value)),
});
export const containerId = (n: number): string => String(n).padStart(64, '0');

/** What the doubles answer, set by each test; the daemon logs each call. */
export type World = {
  readonly held: Set<string>;
  readonly calls: string[];
  /** The store's bytes; the store dies on its next write while `crash` is set. */
  stored: Uint8Array | null;
  crash: boolean;
  /** The store dies at the first write after the daemon's next create. */
  crashAfterCreate: boolean;
  pins: Uint8Array;
  now: number;
  made: number;
  /** A broken list leaves every sweep failing. */
  listBroken: boolean;
  /** The answer to a forwarded delete or kill, else the daemon's own. */
  deleteStatus: number | null;
  killStatus: number;
  waitCode: number;
  /** Holds each create until the test releases it. */
  gate: Promise<void> | null;
};

export function world(stored: Uint8Array | null = seeded()): World {
  return {
    held: new Set(),
    calls: [],
    stored,
    crash: false,
    crashAfterCreate: false,
    pins: pinList(),
    now: T0,
    made: 0,
    listBroken: false,
    deleteStatus: null,
    killStatus: 204,
    waitCode: 0,
    gate: null,
  };
}

function removeAnswer(w: World, id: string): Reply {
  return reply(w.held.delete(id) ? 204 : 404);
}

export function ports(w: World): ProxyPorts {
  return {
    store: {
      read: () => Promise.resolve(w.stored),
      write: (bytes) => {
        if (w.crash) return Promise.reject(new Error('the store died'));
        w.stored = bytes;
        return Promise.resolve();
      },
    },
    pins: () => Promise.resolve(w.pins),
    now: () => w.now,
    daemon: {
      list: () => {
        w.calls.push('list');
        if (w.listBroken) return Promise.resolve(reply(200, [{ Id: 'x' }]));
        return Promise.resolve(
          reply(
            200,
            [...w.held].map((Id) => ({ Id })),
          ),
        );
      },
      remove: (id) => {
        w.calls.push('remove');
        return Promise.resolve(removeAnswer(w, id));
      },
      info: () => {
        w.calls.push('info');
        return Promise.resolve(reply(200, { Containers: w.held.size }));
      },
      forward: async (step) => {
        w.calls.push(step.kind);
        if (step.kind === 'create') {
          await w.gate;
          w.made += 1;
          const id = containerId(w.made);
          w.held.add(id);
          if (w.crashAfterCreate) w.crash = true;
          return reply(201, { Id: id, Warnings: [] });
        }
        if (step.kind === 'delete')
          return w.deleteStatus === null ? removeAnswer(w, step.id) : reply(w.deleteStatus);
        if (step.kind === 'kill') return reply(w.killStatus);
        if (step.kind === 'wait') return reply(200, { StatusCode: w.waitCode });
        return reply(200, {});
      },
    },
  };
}

export async function opened(w: World): Promise<ProxyState> {
  const open = await ProxyState.open(ports(w));
  if (!open.ok) throw new Error(`open refused: ${open.why}`);
  return open.state;
}

/** The record the store holds now. */
export function record(w: World): ProxyRecord {
  const read = w.stored === null ? null : readProxyRecord(w.stored);
  if (read === null || !read.ok) throw new Error('no record');
  return read.record;
}
export const candidateOf = (w: World): Candidate | undefined =>
  record(w).candidates.candidates.at(-1);
export const heldId = (w: World): string | null => record(w).containers.container?.id ?? null;
