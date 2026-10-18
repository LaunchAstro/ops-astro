// SPDX-License-Identifier: AGPL-3.0-only
//
// Proofs from the review of #1893, copied unchanged but for their names: an
// App call spends its own time on the mint, never sends a token past its
// expiry, works with the repository as storage spells it, the smoke reads a
// bound client's repository, and the runbook's App can be installed where it
// promises.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody, siteDestination } from '../../packages/core-custody/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { smokeSite } from '../../scripts/m5/site-custody.ts';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const agency = {
  party: 'party-agency',
  repository: 'LaunchAstro/agency-astro-astro',
  installation: 71,
};
const client = { party: 'party-client', repository: 'ClientCo/client-site', installation: 72 };

async function fixture(
  binding = agency,
  shortLife = false,
  mintDelay = 0,
  answerRepository = binding.repository,
) {
  const seen: string[] = [];
  let expires = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const path = request.url ?? '';
      seen.push(`${request.method} ${path}`);
      if (path.startsWith('/app/')) {
        expires = Date.now() + (shortLife ? 800 : 3_600_000);
        setTimeout(
          () =>
            response.writeHead(201, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                token: 'ghs_sol_synthetic_installation_token',
                expires_at: new Date(expires).toISOString(),
                repositories: [{ full_name: answerRepository }],
              }),
            ),
          mintDelay,
        );
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            path.startsWith('/repos/')
              ? {
                  sha: 'blob',
                  content: Buffer.from('About').toString('base64'),
                  encoding: 'base64',
                }
              : { id: 'project', targets: { production: { id: 'deployment' } } },
          ),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const folder = mkdtempSync(join(tmpdir(), 'sol-1893-'));
  const file = join(folder, 'credentials.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        ref: 'source_control',
        kind: 'api_key',
        account: 'app',
        destination: 'source_control',
        header: 'authorization',
        scheme: 'github_app',
        value: key,
        app: { id: '424242', bindings: [binding] },
      },
      {
        ref: 'hosting',
        kind: 'api_key',
        account: 'hosting',
        destination: 'hosting',
        header: 'authorization',
        scheme: 'bearer',
        value: 'sol_synthetic_hosting_key',
      },
    ]),
    { mode: 0o600 },
  );
  return {
    file,
    origin,
    seen,
    expires: () => expires,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

it('a token that expires while admission waits is never sent', async () => {
  const f = await fixture(agency, true);
  const custody = await startCustody({
    credentialsFile: f.file,
    destinations: [siteDestination('source_control', f.origin)],
  });
  try {
    const result = await custody.dispatch(
      'source_control',
      {
        party: agency.party,
        destination: 'source_control',
        method: 'GET',
        path: `/repos/${agency.repository}/contents/src/pages/about.astro?ref=main`,
        body: '',
        timeoutMs: 5_000,
        maxResponseBytes: 262_144,
      },
      undefined,
      async () => ({
        go: async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, f.expires() - Date.now()) + 150),
          );
          return true;
        },
        end: () => {},
      }),
    );
    expect(
      f.seen.filter((path) => path.startsWith('GET /repos/')),
      'custody must not send with an installation token held past its expiry',
    ).toEqual([]);
    expect(result).toMatchObject({ kind: 'refused' });
  } finally {
    await custody.stop();
    await f.close();
  }
});

it('the documented smoke can verify a bound client repository', async () => {
  const f = await fixture(client);
  try {
    const result = await smokeSite(f.file, {
      party: client.party,
      origins: { source_control: f.origin, hosting: f.origin },
      resolve: async () => ['76.76.21.21'],
    });
    expect(result, 'the client binding is valid and its repository answers successfully').toEqual({
      ok: true,
      lines: ['site.source.read ok', 'site.deployment.current ok'],
    });
    expect(f.seen.some((path) => path.startsWith(`GET /repos/${client.repository}/`))).toBe(true);
  } finally {
    await f.close();
  }
});

// GitHub documents the installation restriction here:
// https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private
// This is an operator instruction, so its contradiction is checked in the runbook itself.
it('the App install runbook permits the client organisations it promises', () => {
  const runbook = readFileSync(
    join(import.meta.dirname, '../../deploy/m5/site-custody.md'),
    'utf8',
  );
  const promisesClientInstall =
    /client.site whose repository is in the client's own organisation[\s\S]*?App installed there/u.test(
      runbook,
    );
  const limitsInstallToOwner = /installable only on\s+this account/u.test(runbook);
  expect(promisesClientInstall).toBe(true);
  expect(
    limitsInstallToOwner,
    'a private GitHub App can only be installed on its owner account, so this setup cannot install on a client organisation',
  ).toBe(false);
});

it('minting spends the outbound request timeout before any repository send', async () => {
  const f = await fixture(agency, false, 250);
  const custody = await startCustody({
    credentialsFile: f.file,
    destinations: [siteDestination('source_control', f.origin)],
  });
  try {
    await custody.dispatch('source_control', {
      party: agency.party,
      destination: 'source_control',
      method: 'GET',
      path: `/repos/${agency.repository}/contents/src/pages/about.astro?ref=main`,
      body: '',
      timeoutMs: 50,
      maxResponseBytes: 262_144,
    });
    expect(
      f.seen.filter((path) => path.startsWith('GET /repos/')),
      'a 250ms mint must not leave a 50ms dispatch time to send another request',
    ).toEqual([]);
  } finally {
    await custody.stop();
    await f.close();
  }
});

it.each([agency.repository, agency.repository.toLowerCase()])(
  'a repository stored by bindPartySite works with App binding %s',
  async (boundRepository) => {
    let storedRepository = '';
    const tx = {
      businessId: 'business-agency',
      async query(sql: string, values: readonly unknown[]) {
        if (sql.includes('insert into public.party_sites')) storedRepository = String(values[2]);
        return [];
      },
      async savepoint(work: (inner: unknown) => Promise<void>) {
        await work(this);
        return true;
      },
    };
    await bindPartySite(
      tx as unknown as TransactionQuery,
      {
        partyId: agency.party,
        repository: agency.repository,
        defaultBranch: 'main',
        project: 'project',
        pages: [],
      },
      'actor-agency',
    );
    expect(storedRepository).toBe(agency.repository.toLowerCase());
    const f = await fixture(
      { ...agency, repository: boundRepository },
      false,
      0,
      agency.repository,
    );
    const custody = await startCustody({
      credentialsFile: f.file,
      destinations: [siteDestination('source_control', f.origin)],
    });
    try {
      const result = await custody.dispatch('source_control', {
        party: agency.party,
        destination: 'source_control',
        method: 'GET',
        path: `/repos/${storedRepository}/contents/src/pages/about.astro?ref=main`,
        body: '',
        timeoutMs: 5_000,
        maxResponseBytes: 262_144,
      });
      expect(
        result,
        'the real storage normalisation and canonical GitHub full_name must interoperate',
      ).toMatchObject({ kind: 'answered', outbound: { ok: true } });
    } finally {
      await custody.stop();
      await f.close();
    }
  },
);
