// SPDX-License-Identifier: AGPL-3.0-only
//
// Proofs from the review of #1893, copied with what they prove unchanged; their
// names differ, and the stand-in lives in github-app-stand-in.ts. An App call
// spends its own time on the mint, never sends a token past its expiry, works
// with the repository as storage spells it, the smoke reads a bound client's
// repository, and the runbook's App can be installed where it promises.

import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { exchangeWith } from '../../packages/core-custody/src/custody-exchange.ts';
import { startCustody, siteDestination } from '../../packages/core-custody/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { smokeSite } from '../../scripts/m5/site-custody.ts';
import { standIn } from './github-app-stand-in.ts';

const agency = {
  party: 'party-agency',
  repository: 'LaunchAstro/agency-astro-astro',
  installation: 71,
};
const client = { party: 'party-client', repository: 'ClientCo/client-site', installation: 72 };

/** A transaction stand-in that keeps the repository bindPartySite inserts. */
function storingTransaction() {
  const stored = { repository: '' };
  const tx = {
    businessId: 'business-agency',
    query(sql: string, values: readonly unknown[]) {
      if (sql.includes('insert into public.party_sites')) stored.repository = String(values[2]);
      return Promise.resolve([]);
    },
    async savepoint(work: (inner: unknown) => Promise<void>) {
      await work(this);
      return true;
    },
  };
  return { tx: tx as unknown as TransactionQuery, stored };
}

/** Custody in its own process, where the second DNS lookup (the repository send) waits 1.2s. */
function custodyWithSlowSecondLookup(credentialsFile: string, origin: string): ChildProcess {
  const bootstrap = join(credentialsFile, '..', 'delayed-dns.mjs');
  const entry = pathToFileURL(
    join(import.meta.dirname, '../../packages/core-custody/src/custody-main.ts'),
  ).href;
  // Resolve to the actual local stand-in; only the second lookup (repository send) waits.
  writeFileSync(
    bootstrap,
    `
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
let calls = 0;
dns.lookup = async () => {
  if (++calls === 2) await new Promise(resolve => setTimeout(resolve, 1200));
  return [{ address: '127.0.0.1', family: 4 }];
};
syncBuiltinESMExports();
await import(${JSON.stringify(entry)});
`,
  );
  return fork(bootstrap, [], {
    execArgv: [],
    env: {
      CUSTODY_CREDENTIALS_FILE: credentialsFile,
      CUSTODY_DESTINATIONS: JSON.stringify([
        siteDestination('source_control', origin.replace('127.0.0.1', 'sol-custody.invalid')),
      ]),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

it('a token that expires while admission waits is never sent', async () => {
  const f = await standIn(agency, { shortLife: true });
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
      () =>
        Promise.resolve({
          go: async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, Math.max(0, f.expires() - Date.now()) + 150);
            });
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
  const f = await standIn(client);
  try {
    const result = await smokeSite(f.file, {
      party: client.party,
      origins: { source_control: f.origin, hosting: f.origin },
      resolve: () => Promise.resolve(['76.76.21.21']),
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
  const f = await standIn(agency, { mintDelay: 250 });
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
    const { tx, stored } = storingTransaction();
    await bindPartySite(
      tx,
      {
        partyId: agency.party,
        repository: agency.repository,
        defaultBranch: 'main',
        project: 'project',
        pages: [],
      },
      'actor-agency',
    );
    expect(stored.repository).toBe(agency.repository.toLowerCase());
    const f = await standIn(
      { ...agency, repository: boundRepository },
      { answerRepository: agency.repository },
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
        path: `/repos/${stored.repository}/contents/src/pages/about.astro?ref=main`,
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

it('a token expiring during DNS is never sent', async () => {
  const f = await standIn(agency, { shortLife: true });
  const child = custodyWithSlowSecondLookup(f.file, f.origin);
  const exchange = exchangeWith(child);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', (message: any) => {
        if (message.type === 'ready') resolve();
      });
      child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
    });
    const result = await exchange({
      type: 'dispatch',
      credentialRef: 'source_control',
      request: {
        party: agency.party,
        destination: 'source_control',
        method: 'GET',
        path: `/repos/${agency.repository}/contents/src/pages/about.astro?ref=main`,
        body: '',
        timeoutMs: 5000,
        maxResponseBytes: 262144,
      },
    });
    expect(Date.now()).toBeGreaterThan(f.expires());
    expect(
      f.seen.filter((path) => path.startsWith('GET /repos/')),
      'expired installation token must not be written after DNS wait',
    ).toEqual([]);
    expect(result).toMatchObject({ type: 'refused' });
  } finally {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
    await f.close();
  }
}, 10000);
