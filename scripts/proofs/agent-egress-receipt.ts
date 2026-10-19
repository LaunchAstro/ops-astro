// SPDX-License-Identifier: AGPL-3.0-only
//
// A6's confinement receipt (agent-egress-conformance.sh), written by root
// inside the confined namespace before the privilege drop, read-only, for the
// process that then becomes the suite: what `tests/harness/egress-confinement.ts`
// checks against itself before it runs anything.
//
//   node agent-egress-receipt.ts <receipt> <pid> <drop status> <listeners.json>   (A6_* facts)

import { chmodSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';

const [receipt = '', pid = '', drop = '', listeners = ''] = process.argv.slice(2);
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`receipt: ${name} is not set`);
  return value;
};

const status = new Map(
  readFileSync(drop, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);
const field = (key: string): string => status.get(key) ?? '';
const table = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean);

writeFileSync(
  receipt,
  `${JSON.stringify(
    {
      pid: Number(pid),
      namespace: readlinkSync('/proc/self/ns/net'),
      outerNamespace: env('A6_OUTER_NAMESPACE'),
      uid: Number(field('Uid').split(/\s+/u)[0]),
      gid: Number(field('Gid').split(/\s+/u)[0]),
      capabilities: Object.fromEntries(
        ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((key) => [key, field(key)]),
      ),
      noNewPrivs: field('NoNewPrivs'),
      routes: { ipv4: table('/proc/net/route').slice(1), ipv6: table('/proc/net/ipv6_route') },
      listeners: JSON.parse(readFileSync(listeners, 'utf8')) as unknown,
      fds: readdirSync(`/proc/${pid}/fd`).map(
        (fd) => `${fd} ${readlinkSync(`/proc/${pid}/fd/${fd}`)}`,
      ),
      node: process.version,
      pnpm: env('A6_PNPM'),
      lockfile: env('A6_LOCKFILE'),
      head: env('A6_HEAD'),
      fixtures: {
        ipv4: env('A6_IPV4'),
        ipv6: env('A6_IPV6'),
        tcpPort: Number(env('A6_TCP_PORT')),
        dnsPort: Number(env('A6_DNS_PORT')),
        name: env('A6_NAME'),
      },
      counters: env('A6_COUNTERS'),
    },
    undefined,
    2,
  )}\n`,
);
chmodSync(receipt, 0o444);
