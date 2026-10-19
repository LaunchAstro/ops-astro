// SPDX-License-Identifier: AGPL-3.0-only
//
// The ways out A6 aims at the supervisor's fixtures (#1623 R8): a socket
// method captured before the agent stack is imported, raw IPv4 and IPv6 TCP,
// a fresh resolver against the fixture's DNS responder on each family, fetch
// on each family, and a child process. The healthy control runs them
// unconfined and each reaches its fixture; the confined suite runs them and
// none may. Node built-ins only, so importing this imports no agent stack.

import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { connect as netConnect, Socket } from 'node:net';

/** Where the fixtures listen, as the wrapper set them up. */
export interface Targets {
  readonly ipv4: string;
  readonly ipv6: string;
  readonly tcpPort: number;
  readonly dnsPort: number;
  readonly name: string;
}

/** What one probe met: the fixture, or the error code that stopped it. */
export interface Outcome {
  readonly reached: boolean;
  readonly code: string;
}

export interface Probe {
  readonly name: string;
  /** The fixture counter a reached probe raises. */
  readonly counter: 'tcp' | 'dns';
  readonly run: () => Promise<Outcome>;
}

/** The fixture's counts: TCP connections accepted and DNS queries answered. */
export interface Counters {
  readonly tcp: number;
  readonly dns: number;
}

export type Connect = typeof Socket.prototype.connect;

const TIMEOUT_MS = 3000;
const reached: Outcome = { reached: true, code: '' };
const codeOf = (error: unknown): string =>
  String((error as { code?: unknown }).code ?? (error as Error).message);

/** A TCP connect through `connect` on a fresh socket. */
const tcp = (connect: Connect, host: string, port: number): Promise<Outcome> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reached: false, code: 'TIMEOUT' });
    }, TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reached);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve({ reached: false, code: codeOf(error) });
    });
    Reflect.apply(connect, socket, [{ host, port }]);
  });

const raw = (host: string, port: number): Promise<Outcome> =>
  new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve(reached);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ reached: false, code: 'TIMEOUT' });
    });
    socket.once('error', (error) => {
      resolve({ reached: false, code: codeOf(error) });
    });
  });

/** A resolver made for this probe, so nothing cached or configured before it answers. */
async function fresh(server: string, targets: Targets): Promise<Outcome> {
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([server]);
  try {
    const addresses = await resolver.resolve4(targets.name);
    return addresses.includes(targets.ipv4) ? reached : { reached: false, code: 'WRONG_ANSWER' };
  } catch (error) {
    return { reached: false, code: codeOf(error) };
  }
}

async function fetched(url: string): Promise<Outcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await response.arrayBuffer();
    return response.ok ? reached : { reached: false, code: `HTTP_${String(response.status)}` };
  } catch (error) {
    return { reached: false, code: codeOf((error as { cause?: unknown }).cause ?? error) };
  }
}

const CHILD = `
const socket = require('node:net').connect({ host: process.argv[1], port: Number(process.argv[2]) });
const done = (outcome) => { process.stdout.write(JSON.stringify(outcome)); process.exit(0); };
socket.setTimeout(${String(TIMEOUT_MS)}, () => done({ reached: false, code: 'TIMEOUT' }));
socket.once('connect', () => done({ reached: true, code: '' }));
socket.once('error', (error) => done({ reached: false, code: String(error.code ?? error.message) }));
`;

/** A child process of its own making the connect, outside anything this process patched. */
const child = (host: string, port: number): Promise<Outcome> =>
  new Promise((resolve) => {
    const proc = spawn(process.execPath, ['-e', CHILD, host, String(port)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once('error', (error) => {
      resolve({ reached: false, code: `SPAWN_${codeOf(error)}` });
    });
    proc.once('close', () => {
      try {
        resolve(JSON.parse(out) as Outcome);
      } catch {
        resolve({ reached: false, code: 'CHILD_SAID_NOTHING' });
      }
    });
  });

/** Every probe, in order, aimed at `targets`; `captured` is the socket method taken before the stack. */
export function egressProbes(targets: Targets, captured: Connect): readonly Probe[] {
  const { ipv4, ipv6, tcpPort, dnsPort } = targets;
  return [
    { name: 'captured socket', counter: 'tcp', run: () => tcp(captured, ipv4, tcpPort) },
    { name: 'raw tcp ipv4', counter: 'tcp', run: () => raw(ipv4, tcpPort) },
    { name: 'raw tcp ipv6', counter: 'tcp', run: () => raw(ipv6, tcpPort) },
    {
      name: 'fresh dns ipv4',
      counter: 'dns',
      run: () => fresh(`${ipv4}:${String(dnsPort)}`, targets),
    },
    {
      name: 'fresh dns ipv6',
      counter: 'dns',
      run: () => fresh(`[${ipv6}]:${String(dnsPort)}`, targets),
    },
    {
      name: 'fetch ipv4',
      counter: 'tcp',
      run: () => fetched(`http://${ipv4}:${String(tcpPort)}/`),
    },
    {
      name: 'fetch ipv6',
      counter: 'tcp',
      run: () => fetched(`http://[${ipv6}]:${String(tcpPort)}/`),
    },
    { name: 'child process', counter: 'tcp', run: () => child(ipv4, tcpPort) },
  ];
}

export const countersAt = (file: string): Counters =>
  JSON.parse(readFileSync(file, 'utf8')) as Counters;
