// SPDX-License-Identifier: AGPL-3.0-only
//
// A local stand-in for GitHub and the host, and a credential file holding one
// App entry bound to one party's repository and a hosting key. The stand-in
// mints installation tokens on `/app/`, answers a repository read on
// `/repos/` and a deployment read on anything else. `close` removes both.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Binding {
  readonly party: string;
  readonly repository: string;
  readonly installation: number;
}

export interface StandInOptions {
  /** The minted token lives 800ms instead of an hour. */
  readonly shortLife?: boolean;
  /** How long the token endpoint waits before it answers. */
  readonly mintDelay?: number;
  /** The repository the mint answer names; the binding's own when absent. */
  readonly answerRepository?: string;
}

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

interface Minted {
  readonly seen: string[];
  expires: number;
}

function answer(
  path: string,
  response: ServerResponse,
  minted: Minted,
  { shortLife = false, mintDelay = 0, answerRepository = '' }: StandInOptions,
): void {
  if (path.startsWith('/app/')) {
    minted.expires = Date.now() + (shortLife ? 800 : 3_600_000);
    setTimeout(
      () =>
        response.writeHead(201, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            token: 'ghs_sol_synthetic_installation_token',
            expires_at: new Date(minted.expires).toISOString(),
            repositories: [{ full_name: answerRepository }],
          }),
        ),
      mintDelay,
    );
    return;
  }
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(
      JSON.stringify(
        path.startsWith('/repos/')
          ? { sha: 'blob', content: Buffer.from('About').toString('base64'), encoding: 'base64' }
          : { id: 'project', targets: { production: { id: 'deployment' } } },
      ),
    );
}

function writeCredentials(folder: string, binding: Binding): string {
  const file = join(folder, 'credentials.json');
  const app = {
    ref: 'source_control',
    kind: 'api_key',
    account: 'app',
    destination: 'source_control',
    header: 'authorization',
    scheme: 'github_app',
    value: key,
    app: { id: '424242', bindings: [binding] },
  };
  const hosting = {
    ref: 'hosting',
    kind: 'api_key',
    account: 'hosting',
    destination: 'hosting',
    header: 'authorization',
    scheme: 'bearer',
    value: 'sol_synthetic_hosting_key',
  };
  writeFileSync(file, JSON.stringify([app, hosting]), { mode: 0o600 });
  return file;
}

export interface StandIn {
  /** The credential file custody reads. */
  readonly file: string;
  readonly origin: string;
  /** Each request as `<method> <path>`, in arrival order. */
  readonly seen: readonly string[];
  /** When the last minted token expires, in epoch milliseconds; 0 before any mint. */
  expires(): number;
  close(): Promise<void>;
}

export async function standIn(binding: Binding, options: StandInOptions = {}): Promise<StandIn> {
  const minted: Minted = { seen: [], expires: 0 };
  const answerRepository = options.answerRepository ?? binding.repository;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      const path = request.url ?? '';
      minted.seen.push(`${request.method} ${path}`);
      answer(path, response, minted, { ...options, answerRepository });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const folder = mkdtempSync(join(tmpdir(), 'sol-1893-'));
  return {
    file: writeCredentials(folder, binding),
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen: minted.seen,
    expires: () => minted.expires,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
