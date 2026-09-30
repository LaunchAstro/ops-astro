// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging's one way out (ticket S0-1 containment; ORCH40's egress ruling): the
// worker, its forwarder and the backup dump reach exactly four places, each
// named by a setting, and nothing else.
//
//   node scripts/ops/egress.mjs relay | out
//
// Two hops, so no name loops back: `relay` sits on the internal staging
// network and answers there for the four host names (its network aliases); it
// takes the name a client asked for from the TLS hello's server name (port
// 443) or from the pooler's own port, and hands the bytes to `out` over an
// internal link, prefixed with that name and port. `out` alone is on a network
// with a route out; it checks the pair against the same list again and relays
// the bytes unchanged. Neither ends TLS, so every client still checks the real
// host's certificate. A pair off the list is closed with nothing sent on.
//
// Settings: STAGING_WEB_URL, the very address the worker is given for the API,
// whose host is the API's place (one source, so no setting can swap it);
// OPS_EGRESS_HEARTBEAT_HOST, OPS_EGRESS_SINK_HOST (https, port 443),
// OPS_EGRESS_POOLER_HOST and OPS_EGRESS_POOLER_PORT (the Supabase pooler). The
// relay also takes OPS_EGRESS_API_ALIAS, the name it answers to for the API,
// and refuses to start unless it is that host. The worker unit and the dump
// check their own addresses against the same host settings when they start
// (`offEgress`, apps/worker/heartbeat.ts), so the four are what they need.
// Exit 1 names a bad setting, never its value.

import { connect, createServer } from 'node:net';

const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const LINK_PORT = 9443;
const HELLO_LIMIT = 16_384;

/** The API's host from the worker's own address: https, port 443, nothing but a host. */
function apiHost(env) {
  const url = URL.parse(env['STAGING_WEB_URL'] ?? '');
  const bare = url?.username === '' && url.password === '' && url.search === '' && url.hash === '';
  if (url?.protocol !== 'https:' || url.port !== '' || !bare || !['/', ''].includes(url.pathname))
    throw new Error('STAGING_WEB_URL is not an https address of a host alone.');
  if (!HOST.test(url.hostname)) throw new Error('STAGING_WEB_URL is not set to a host name.');
  return url.hostname;
}

/** The allow-list: exactly four destinations, each from its setting. */
export function allowList(env) {
  const host = (name) => {
    const value = env[name] ?? '';
    if (!HOST.test(value)) throw new Error(`${name} is not set to a host name.`);
    return value;
  };
  const port = Number(env['OPS_EGRESS_POOLER_PORT'] ?? '');
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 443) {
    throw new Error('OPS_EGRESS_POOLER_PORT is not a port other than 443.');
  }
  return [
    [apiHost(env), 443],
    [host('OPS_EGRESS_POOLER_HOST'), port],
    [host('OPS_EGRESS_HEARTBEAT_HOST'), 443],
    [host('OPS_EGRESS_SINK_HOST'), 443],
  ];
}

const listed = (list, host, port) => list.some(([h, p]) => h === host && p === port);

/** The server name in a TLS ClientHello, or undefined when there is none to read. */
export function serverName(hello) {
  try {
    if (hello[0] !== 0x16 || hello[5] !== 0x01) return;
    let at = 5 + 4 + 2 + 32;
    at += 1 + hello[at];
    at += 2 + hello.readUInt16BE(at);
    at += 1 + hello[at];
    const end = at + 2 + hello.readUInt16BE(at);
    for (at += 2; at + 4 <= end;) {
      const [type, size] = [hello.readUInt16BE(at), hello.readUInt16BE(at + 2)];
      if (type === 0 && hello[at + 6] === 0) {
        const name = hello.subarray(at + 9, at + 9 + hello.readUInt16BE(at + 7)).toString('latin1');
        return name.toLowerCase();
      }
      at += 4 + size;
    }
  } catch {
    // A short or malformed hello names nothing.
  }
}

/** Reads until `pick` names a pair or gives up; the bytes read so far travel on with it. */
function firstBytes(socket, pick, done) {
  let held = Buffer.alloc(0);
  const read = (chunk) => {
    held = Buffer.concat([held, chunk]);
    const pair = pick(held);
    if (pair === null && held.length < HELLO_LIMIT) return;
    socket.off('data', read);
    socket.pause();
    // The limit is for the first bytes only: a pooled connection may idle after.
    socket.setTimeout(0);
    done(pair ?? undefined, held);
  };
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on('data', read);
  socket.on('error', () => socket.destroy());
}

function pipeTo(socket, host, port, first) {
  const upstream = connect({ host, port }, () => {
    upstream.write(first);
    socket.pipe(upstream).pipe(socket);
    socket.resume();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

function relay(list, out) {
  const [, poolerPort] = list[1];
  const onPort = (port) => (socket) =>
    firstBytes(
      socket,
      (held) => {
        if (port !== 443) return [list[1][0], port];
        const name = serverName(held);
        return name === undefined ? null : [name, 443];
      },
      (pair, held) => {
        if (pair === undefined || !listed(list, ...pair)) return socket.destroy();
        pipeTo(
          socket,
          out,
          LINK_PORT,
          Buffer.concat([Buffer.from(`${pair[0]} ${pair[1]}\n`), held]),
        );
      },
    );
  createServer(onPort(443)).listen(443);
  createServer(onPort(poolerPort)).listen(poolerPort);
}

function outward(list) {
  createServer((socket) =>
    firstBytes(
      socket,
      (held) => (held.includes(10) ? held.subarray(0, held.indexOf(10)).toString('latin1') : null),
      (line, held) => {
        const [host = '', port = ''] = (line ?? '').split(' ');
        if (!listed(list, host, Number(port))) return socket.destroy();
        pipeTo(socket, host, Number(port), held.subarray(held.indexOf(10) + 1));
      },
    ),
  ).listen(LINK_PORT);
}

if (import.meta.main) {
  const mode = process.argv[2];
  let list;
  try {
    if (mode !== 'relay' && mode !== 'out') throw new Error('usage: egress.mjs relay | out');
    list = allowList(process.env);
    if (mode === 'relay' && process.env['OPS_EGRESS_API_ALIAS'] !== list[0][0])
      throw new Error('OPS_EGRESS_API_ALIAS is not the host of STAGING_WEB_URL.');
  } catch (error) {
    process.stderr.write(`egress: ${error.message}\n`);
    process.exit(1);
  }
  if (mode === 'relay') relay(list, process.env['OPS_EGRESS_OUT'] ?? 'egress-out');
  else outward(list);
}
