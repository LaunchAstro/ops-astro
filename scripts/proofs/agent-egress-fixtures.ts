// SPDX-License-Identifier: AGPL-3.0-only
//
// The supervisor's fixtures for A6 (agent-egress-conformance.sh), run in a
// network namespace of their own: an HTTP listener and a DNS responder on the
// fixture IPv4 and IPv6 addresses. Every TCP connection accepted and every
// DNS query answered raises a counter in `<work>/counters.json`, which the
// healthy control must raise and the confined suite must not.
//
//   node agent-egress-fixtures.ts <work>   (A6_IPV4, A6_IPV6, A6_TCP_PORT, A6_DNS_PORT, A6_NAME)

import { createSocket } from 'node:dgram';
import { renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const work = process.argv[2] ?? '';
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`fixtures: ${name} is not set`);
  return value;
};
const ipv4 = env('A6_IPV4');
const ipv6 = env('A6_IPV6');
const tcpPort = Number(env('A6_TCP_PORT'));
const dnsPort = Number(env('A6_DNS_PORT'));

const counters = { tcp: 0, dns: 0 };
const counted = (): void => {
  const file = join(work, 'counters.json');
  writeFileSync(`${file}.next`, JSON.stringify(counters), { mode: 0o644 });
  renameSync(`${file}.next`, file);
};

/** An A record for any name, the fixture's IPv4 address; any other type gets no answer. */
function answer(query: Buffer): Buffer | undefined {
  if (query.length < 17) return undefined;
  let at = 12;
  while (at < query.length && query[at] !== 0) at += (query[at] ?? 0) + 1;
  if (at + 5 > query.length) return undefined;
  const type = query.readUInt16BE(at + 1);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(type === 1 ? 1 : 0, 6);
  const question = query.subarray(12, at + 5);
  if (type !== 1) return Buffer.concat([header, question]);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(0, 6);
  record.writeUInt16BE(4, 10);
  for (const [index, part] of ipv4.split('.').entries()) record[12 + index] = Number(part);
  return Buffer.concat([header, question, record]);
}

/** An HTTP listener on `host` that counts each connection it accepts. */
const served = (host: string): Promise<void> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.end('fixture');
    });
    server.on('connection', () => {
      counters.tcp += 1;
      counted();
    });
    server.listen({ host, port: tcpPort, ipv6Only: host.includes(':') }, resolve);
  });

/** A DNS responder on `host` that counts each query it answers. */
const answering = (host: string): Promise<void> =>
  new Promise((resolve) => {
    const socket = createSocket(
      host.includes(':') ? { type: 'udp6', ipv6Only: true } : { type: 'udp4' },
    );
    socket.on('message', (query, from) => {
      counters.dns += 1;
      counted();
      const reply = answer(query);
      if (reply !== undefined) socket.send(reply, from.port, from.address);
    });
    socket.bind(dnsPort, host, resolve);
  });

counted();
await Promise.all([served(ipv4), served(ipv6), answering(ipv4), answering(ipv6)]);
writeFileSync(join(work, 'fixtures.ready'), String(process.pid));
