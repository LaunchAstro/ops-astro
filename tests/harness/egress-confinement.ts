// SPDX-License-Identifier: AGPL-3.0-only
//
// The confined A6 suite's way in (#1623 R8): it runs only on a valid
// confinement receipt for its own process, and refuses otherwise. The
// receipt is the wrapper's (scripts/proofs/agent-egress-conformance.sh),
// written by root before the privilege drop and read-only, so this process
// cannot have written it. Each fact it states is checked against this
// process as it is now: the network namespace, an ancestor's pid, every
// identity and capability dropped, routes and addresses on loopback only, the
// labelled listeners and no others, no network descriptor from outside the
// namespace, and the Node and lockfile the suite runs on.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Targets } from './egress-probes.ts';

export interface Listener {
  readonly label: string;
  readonly address: string;
  readonly port: number;
}

export interface Receipt {
  readonly pid: number;
  readonly namespace: string;
  readonly outerNamespace: string;
  readonly uid: number;
  readonly gid: number;
  readonly capabilities: Readonly<Record<string, string>>;
  readonly noNewPrivs: string;
  readonly routes: { readonly ipv4: readonly string[]; readonly ipv6: readonly string[] };
  readonly listeners: readonly Listener[];
  readonly fds: readonly string[];
  readonly node: string;
  readonly pnpm: string;
  readonly lockfile: string;
  readonly head: string;
  readonly fixtures: Targets;
  /** The fixtures' counter file. */
  readonly counters: string;
}

const CAPABILITIES = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'] as const;
const NONE = '0000000000000000';

const refused = (reason: string): Error => new Error(`A6 refused: ${reason}`);

const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);

function status(pid: number | 'self'): ReadonlyMap<string, string> {
  return new Map(
    lines(`/proc/${String(pid)}/status`).map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at), line.slice(at + 1).trim()] as const;
    }),
  );
}

function ancestors(): number[] {
  const found: number[] = [];
  let pid = Number(status('self').get('PPid'));
  while (pid > 0) {
    found.push(pid);
    pid = Number(status(pid).get('PPid'));
  }
  return found;
}

/** Each listening TCP socket in this namespace, as `hexaddress:port`. */
const listening = (): string[] =>
  ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((file) =>
    lines(file)
      .slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields[3] === '0A')
      .map((fields) => {
        const [address = '', port = ''] = (fields[1] ?? '').split(':');
        return `${address}:${String(Number.parseInt(port, 16))}`;
      }),
  );

/** 127.0.0.1 as /proc/net/tcp writes it. */
const hexLoopback = (address: string): string =>
  address
    .split('.')
    .map((part) => Number(part).toString(16).padStart(2, '0').toUpperCase())
    .toReversed()
    .join('');

/** Every socket inode this namespace knows of, by the table that lists it. */
function namespaceSockets(): Set<string> {
  const tables: readonly (readonly [string, number])[] = [
    ['unix', 6],
    ['tcp', 9],
    ['tcp6', 9],
    ['udp', 9],
    ['udp6', 9],
    ['raw', 9],
    ['raw6', 9],
    ['netlink', 9],
  ];
  return new Set(
    tables.flatMap(([table, column]) =>
      existsSync(`/proc/net/${table}`)
        ? lines(`/proc/net/${table}`)
            .slice(1)
            .map((line) => line.trim().split(/\s+/u)[column] ?? '')
        : [],
    ),
  );
}

function inheritedSockets(): string[] {
  const known = namespaceSockets();
  return readdirSync('/proc/self/fd').flatMap((fd) => {
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return [];
    }
    const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
    return inode === undefined || known.has(inode) ? [] : [`fd ${fd} ${target}`];
  });
}

/** The receipt itself: present, root's and read-only, on the one platform that confines. */
function receiptAt(path: string | undefined): Receipt {
  if (path === undefined || path === '' || !existsSync(path)) {
    throw refused('no confinement receipt');
  }
  if (process.platform !== 'linux') throw refused(`no kernel confinement on ${process.platform}`);
  const stat = statSync(path);
  if (stat.uid !== 0 || (stat.mode & 0o222) !== 0) {
    throw refused('the receipt is not root-owned and read-only');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Receipt;
}

/** Whose the receipt is: this namespace, not the supervisor's, and an ancestor's pid. */
function whose(receipt: Receipt): string | undefined {
  const namespace = readlinkSync('/proc/self/ns/net');
  if (receipt.namespace !== namespace) {
    return `the receipt is for ${receipt.namespace}, not ${namespace}`;
  }
  if (receipt.outerNamespace === namespace) return 'the namespace is the supervisor namespace';
  if (!ancestors().includes(receipt.pid)) {
    return `pid ${String(receipt.pid)} is not an ancestor of this process`;
  }
  return undefined;
}

/** Who this process is: the dropped ids, no groups, no capability, no escalation. */
function who(receipt: Receipt): string | undefined {
  const self = status('self');
  const ids = (key: string): string[] => (self.get(key) ?? '').split(/\s+/u);
  if (receipt.uid === 0 || ids('Uid').some((id) => Number(id) !== receipt.uid)) {
    return `uid ${self.get('Uid') ?? ''} is not the dropped ${String(receipt.uid)}`;
  }
  if (ids('Gid').some((id) => Number(id) !== receipt.gid)) return 'the gid was not dropped';
  if ((self.get('Groups') ?? '') !== '') return 'supplementary groups remain';
  const kept = CAPABILITIES.find(
    (key) => self.get(key) !== NONE || receipt.capabilities[key] !== NONE,
  );
  if (kept !== undefined) return `${kept} is not empty`;
  if (self.get('NoNewPrivs') !== '1' || receipt.noNewPrivs !== '1') {
    return 'privilege escalation is not refused';
  }
  return undefined;
}

/** What the namespace holds: loopback routes and addresses, the labelled listeners, nothing inherited. */
function network(receipt: Receipt): string | undefined {
  if (lines('/proc/net/route').length > 1) return 'an IPv4 route is present';
  const offLoopback = (table: string): boolean =>
    lines(table).some((line) => line.trim().split(/\s+/u).at(-1) !== 'lo');
  if (offLoopback('/proc/net/ipv6_route')) return 'an IPv6 route leaves loopback';
  if (offLoopback('/proc/net/if_inet6')) return 'an address is off loopback';
  const labelled = receipt.listeners.map(
    ({ address, port }) => `${hexLoopback(address)}:${String(port)}`,
  );
  const open = listening();
  if (
    receipt.listeners.some(({ address }) => address !== '127.0.0.1') ||
    open.length !== labelled.length ||
    open.some((listener) => !labelled.includes(listener))
  ) {
    return `listeners ${open.join(', ')} are not the labelled ${labelled.join(', ')}`;
  }
  const inherited = inheritedSockets();
  return inherited.length > 0
    ? `a network descriptor from outside: ${inherited.join(', ')}`
    : undefined;
}

/** The stack the suite runs on: the receipt's Node and lockfile. */
function stack(receipt: Receipt, root: string): string | undefined {
  if (receipt.node !== process.version) return `Node ${process.version}, receipt ${receipt.node}`;
  const lockfile = createHash('sha256')
    .update(readFileSync(join(root, 'pnpm-lock.yaml')))
    .digest('hex');
  return receipt.lockfile === lockfile
    ? undefined
    : 'the lockfile is not the one the receipt names';
}

/**
 * The receipt at `env.A6_RECEIPT`, once every fact in it holds for this
 * process; otherwise the first that does not, thrown as the refusal.
 */
export function confinement(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): Receipt {
  const receipt = receiptAt(env['A6_RECEIPT']);
  const reason = whose(receipt) ?? who(receipt) ?? network(receipt) ?? stack(receipt, root);
  if (reason !== undefined) throw refused(reason);
  return receipt;
}
