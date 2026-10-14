// SPDX-License-Identifier: AGPL-3.0-only
//
// A loopback stand-in for the plan token issuer: it counts requests and
// answers as the test sets it. It binds 127.0.0.1 only and holds synthetic
// token text only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type IssuerMode =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'raw'; readonly status: number; readonly bytes: Buffer }
  | { readonly kind: 'reset' }
  | { readonly kind: 'stall' };

export interface Issuer {
  readonly url: URL;
  count(): number;
  set(mode: IssuerMode): void;
  /** Runs when a request has been read in full, before the answer. */
  onRequest(hook: (form: URLSearchParams) => Promise<void> | void): void;
  close(): Promise<void>;
}

const ignore = (): void => {};

// oxlint-disable-next-line max-lines-per-function -- one stand-in: its count, its mode, its hook and its close
export async function startIssuer(): Promise<Issuer> {
  let requests = 0;
  let mode: IssuerMode = { kind: 'json', status: 200, body: {} };
  let hook: (form: URLSearchParams) => Promise<void> | void = ignore;
  const open = new Set<ServerResponse>();
  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests += 1;
    await hook(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    const now = mode;
    if (now.kind === 'reset') {
      req.socket.destroy();
      return;
    }
    if (now.kind === 'stall') {
      open.add(res);
      return;
    }
    const bytes = now.kind === 'raw' ? now.bytes : Buffer.from(JSON.stringify(now.body));
    res.writeHead(now.status, {
      'content-type': 'application/json',
      'content-length': bytes.length,
    });
    res.end(bytes);
  };
  const server = createServer((req, res) => {
    void answer(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/api/accounts/oauth/token`),
    count: () => requests,
    set: (next) => {
      mode = next;
    },
    onRequest: (next) => {
      hook = next;
    },
    close: async () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
