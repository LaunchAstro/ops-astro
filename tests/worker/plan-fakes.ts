// SPDX-License-Identifier: AGPL-3.0-only
//
// A fake HTTP endpoint on loopback for the owner's plan proofs: it keeps
// every request it hears, path, headers and body whole, and answers each as
// the test sets. It stands in for the Responses endpoint and the sign-in's
// token endpoint, so no call leaves the machine.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface Heard {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Fake {
  readonly origin: string;
  readonly heard: Heard[];
  answer: (heard: Heard) => { status: number; type: string; body: string };
  close(): Promise<void>;
}

export async function fake(): Promise<Fake> {
  const state = {
    heard: [] as Heard[],
    answer: (_heard: Heard) => ({ status: 500, type: 'text/plain', body: '' }),
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const heard = { path: request.url ?? '', headers: request.headers, body };
      state.heard.push(heard);
      const answer = state.answer(heard);
      response.writeHead(answer.status, { 'content-type': answer.type });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}
