// SPDX-License-Identifier: AGPL-3.0-only
//
// What the socket proxy sends the daemon (docs/plan/sandbox-contract.md, P1
// and P5): every request rebuilt from a checked operation, never the bytes
// the launcher sent. A load's head carries the length of the archive the
// proxy rebuilt, so the daemon reads exactly that archive.

import { fixedCreateBody } from './create-body.ts';
import { ATTACH_QUERY, CONTAINER_ID, IMAGE_ID, type ProxyOp } from './proxy-request.ts';

const LINES: Readonly<
  Record<Exclude<ProxyOp['kind'], 'load'>, (op: never) => readonly [string, string]>
> = {
  ping: () => ['GET', '_ping'],
  version: () => ['GET', 'version'],
  info: () => ['GET', 'info'],
  create: () => ['POST', 'containers/create'],
  attach: (op: { id: string }) => ['POST', `containers/${op.id}/attach?${ATTACH_QUERY}`],
  start: (op: { id: string }) => ['POST', `containers/${op.id}/start`],
  wait: (op: { id: string }) => ['POST', `containers/${op.id}/wait`],
  kill: (op: { id: string }) => ['POST', `containers/${op.id}/kill`],
  inspect: (op: { id: string }) => ['GET', `containers/${op.id}/json`],
  delete: (op: { id: string }) => ['DELETE', `containers/${op.id}?force=1`],
  'image-inspect': (op: { image: string }) => ['GET', `images/${op.image}/json`],
  'image-delete': (op: { image: string }) => ['DELETE', `images/${op.image}`],
};

const encoder = new TextEncoder();
const requestHead = (method: string, target: string, apiVersion: string, headers: string) =>
  encoder.encode(`${method} /v${apiVersion}/${target} HTTP/1.1\r\nHost: docker\r\n${headers}\r\n`);

/**
 * The head of a forwarded load. Its length is the archive the proxy rebuilt
 * (P5), never the length the launcher declared, so the daemon reads exactly
 * that archive and nothing after it as a second request.
 */
export function forwardLoadHead(archiveLength: number, apiVersion: string): Uint8Array {
  if (!Number.isSafeInteger(archiveLength) || archiveLength < 0)
    throw new RangeError('archive length');
  const headers = `Content-Type: application/x-tar\r\nContent-Length: ${archiveLength}\r\n`;
  return requestHead('POST', 'images/load?quiet=1', apiVersion, headers);
}

/** The bytes the proxy sends the daemon for a checked operation other than a load. */
export function forwardBytes(
  op: Exclude<ProxyOp, { kind: 'load' }>,
  apiVersion: string,
): Uint8Array {
  // Callers past this grammar (the sweep) build their own operations, so the ids are checked again here.
  if ('id' in op && !CONTAINER_ID.test(op.id)) throw new RangeError('container id');
  if ('image' in op && !IMAGE_ID.test(op.image)) throw new RangeError('image id');
  const [method, target] = LINES[op.kind](op as never);
  let headers = '';
  let body = new Uint8Array();
  if (op.kind === 'create') {
    body = encoder.encode(JSON.stringify(fixedCreateBody(op.shape, op.image)));
    headers = `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n`;
  } else if (op.kind === 'attach') {
    headers = 'Connection: Upgrade\r\nUpgrade: tcp\r\n';
  }
  const head = requestHead(method, target, apiVersion, headers);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}
