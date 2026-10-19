// SPDX-License-Identifier: AGPL-3.0-only
//
// The providers' double served over loopback HTTP, so real custody can stand
// between the site runner and it: one server answering as the source host,
// one as the hosting host, and one serving the agency page from the site file
// as it stands. Each keeps the authorization header custody sent. A planted
// canary credential file names both site entries.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './c80-site-provider.ts';
import { REV, PAGE } from './c80-world.ts';
import type { ConfiguredSite } from '../../apps/site-runner/configured.ts';
import { custodySites } from '../../apps/site-runner/sites.ts';
import type { Sites } from '../../apps/site-runner/runner.ts';
import type { Transport } from '../../packages/core-connectors/src/index.ts';
import {
  siteDestination,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

/** The planted credentials, raw: custody presents each as a bearer. */
export const CANARY: { readonly source_control: string; readonly hosting: string } = {
  source_control: `canary-${randomBytes(18).toString('hex')}`,
  hosting: `canary-${randomBytes(18).toString('hex')}`,
} as const;

export interface Served {
  readonly origins: { readonly source: string; readonly hosting: string; readonly page: string };
  /** Every authorization header the provider servers received. */
  readonly authorizations: string[];
  readonly credentialsFile: string;
  readonly close: () => Promise<void>;
}

const bodyOf = async (request: IncomingMessage): Promise<Uint8Array | undefined> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : new Uint8Array(Buffer.concat(chunks));
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** A server answering as `host` from the double's transport. */
function asHost(site: Provider, host: string, authorizations: string[]): Server {
  // The file at the base revision stays as it was, as the provider keeps a commit.
  const base = {
    sha: site.state.blob,
    content: Buffer.from(site.state.content).toString('base64'),
  };
  return createServer((request, response) => {
    void (async () => {
      if (new URL(request.url ?? '/', 'http://x').searchParams.get('ref') === BASE_REVISION) {
        authorizations.push(String(request.headers.authorization ?? ''));
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ...base, encoding: 'base64' }));
        return;
      }
      authorizations.push(String(request.headers.authorization ?? ''));
      const body = await bodyOf(request);
      const answer = await site.deps.transport({
        url: new URL(`https://${host}${request.url ?? '/'}`),
        address: '127.0.0.1',
        family: 4,
        method: (request.method ?? 'GET') as 'GET' | 'PATCH' | 'POST' | 'PUT',
        headers: {},
        ...(body === undefined ? {} : { body }),
        timeoutMs: 10_000,
        maxBytes: 262_144,
      });
      if (answer.kind === 'answer')
        response.writeHead(answer.status, answer.headers).end(Buffer.from(answer.body));
      else response.writeHead(502).end();
    })();
  });
}

/** The base revision every correction in the world is requested at (`requestBody`). */
const BASE_REVISION = REV;

const html = (text: string): string =>
  `<!doctype html><html><body><main>${text}</main></body></html>`;

export async function serve(site: Provider): Promise<Served> {
  const authorizations: string[] = [];
  const source = asHost(site, 'api.github.com', authorizations);
  const hosting = asHost(site, 'api.vercel.com', authorizations);
  const page = createServer((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(html(site.state.content));
  });
  const folder = mkdtempSync(join(tmpdir(), 'site-runner-'));
  const credentialsFile = join(folder, 'credentials.json');
  const entries = (['source_control', 'hosting'] as const).map((ref) => ({
    ref,
    kind: 'api_key',
    account: `${ref}-canary`,
    destination: ref,
    header: 'authorization',
    value: CANARY[ref],
  }));
  writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
  const origins = {
    source: await listen(source),
    hosting: await listen(hosting),
    page: await listen(page),
  };
  const close = async () => {
    for (const server of [source, hosting, page]) {
      server.closeAllConnections();
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    rmSync(folder, { recursive: true, force: true });
  };
  return { origins, authorizations, credentialsFile, close };
}

/** The runner's custody-backed ports over the served providers, the agency page fetched from its server. */
export function sitesOver(
  custody: Pick<Custody, 'dispatch'>,
  origins: Served['origins'],
  now: () => number,
  site: ConfiguredSite,
): Sites {
  const transport: Transport = async () => {
    const answer = await fetch(origins.page);
    const headers = { 'content-type': answer.headers.get('content-type') ?? '' };
    return {
      kind: 'answer',
      status: answer.status,
      headers,
      body: new Uint8Array(await answer.arrayBuffer()),
    };
  };
  return custodySites(
    {
      custody,
      resolve: (host) =>
        Promise.resolve([host === 'api.vercel.com' ? '76.76.21.21' : '140.82.112.6']),
      capture: {
        pool: { agencyPages: [PAGE], otherPages: [], closedPoolReviews: [] },
        resolve: () => Promise.resolve(['93.184.216.34']),
        transport,
      },
      wait: () => Promise.resolve(),
      now,
    },
    site,
  );
}

/** Custody with the two site entries from the canary file, each on its served origin. */
export async function custodyOver(served: Served): ReturnType<typeof startCustody> {
  return await startCustody({
    credentialsFile: served.credentialsFile,
    destinations: [
      siteDestination('source_control', served.origins.source),
      siteDestination('hosting', served.origins.hosting),
    ],
  });
}
