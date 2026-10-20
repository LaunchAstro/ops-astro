// SPDX-License-Identifier: AGPL-3.0-only
//
// The real custody process holding a seeded plan pair, sending to a loopback
// endpoint a case answers by hand: the response is the case's to write, cut
// short or leave hanging, once the whole request has arrived.

import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { startCustody, type ProcessCustody } from '../../../packages/core-custody/src/custody.ts';
import { seed, tempDir, tokens, HOUR } from './plan-token-world.ts';

export interface InflightWorld {
  readonly custody: ProcessCustody;
  readonly dir: ReturnType<typeof tempDir>;
  /** The pair custody holds at the start. */
  readonly old: { readonly accessToken: string; readonly refreshToken: string };
  /** Resolves once the whole request has arrived. */
  readonly arrived: Promise<void>;
  /** How the endpoint answers the request, once it has all arrived. */
  onRequest(fn: (response: ServerResponse) => void): void;
  close(): Promise<void>;
}

/** Custody holding a fresh seeded pair, prepared, sending the plan to a loopback endpoint. */
export async function open(): Promise<InflightWorld> {
  const dir = tempDir();
  const old = {
    ...tokens('before', Date.now() + 2 * HOUR),
    accessToken: randomBytes(48).toString('base64url'),
    refreshToken: randomBytes(48).toString('base64url'),
  };
  await seed(dir.file, { state: 'ready', tokens: old });
  const credentialsFile = join(dir.dir, 'credentials.json');
  writeFileSync(credentialsFile, '[]', { mode: 0o600 });
  let respond!: (response: ServerResponse) => void;
  let received!: () => void;
  const arrived = new Promise<void>((done) => {
    received = done;
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      respond(res);
      received();
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const port = (server.address() as { port: number }).port;
  const custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'chatgpt_plan', origin: `http://127.0.0.1:${port}` }],
    plan: { tokenFile: dir.file, issuer: 'https://auth.openai.com' },
  });
  expect(await custody.prepare()).toEqual({ ok: true });
  return {
    custody,
    dir,
    old,
    arrived,
    onRequest: (fn: (response: ServerResponse) => void): void => {
      respond = fn;
    },
    close: async (): Promise<void> => {
      await custody.stop();
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => done());
      });
      dir.done();
    },
  };
}
