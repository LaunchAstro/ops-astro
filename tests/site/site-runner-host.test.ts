// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's host pieces (#1692) with real custody in front of the
// providers' double, served over loopback: custody alone sends the planted
// canary credentials, and none of it reaches the runner's records, outcomes
// or output; the providers are reached only through custody's two catalogued
// destinations. A runner stopped after its publish, in a process of its own,
// is followed by a new one on a new lease that observes again and never sends
// twice.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { BEFORE } from './c80-world.ts';
import { provider, type Provider } from './c80-site-provider.ts';
import {
  approved,
  entries,
  handBack,
  lease,
  serverUrl,
  takeOver,
  w,
} from './c80-register-world.ts';
import {
  building,
  built,
  merges,
  runnerOn,
  time,
  useRunnerWorld,
  type World,
} from './site-runner-world.ts';
import { CANARY, custodyOver, serve, sitesOver, type Served } from './site-runner-servers.ts';

useRunnerWorld();

const run = promisify(execFile);

/** The served double, custody over it, and a runner world on custody's ports. */
async function hosted(): Promise<{
  site: Provider;
  served: Served;
  given: World;
  stop: () => Promise<void>;
}> {
  const site = provider({ content: BEFORE });
  const served = await serve(site);
  const custody = await custodyOver(served).catch(async (fault: unknown) => {
    await served.close();
    throw fault;
  });
  const given: World = {
    site,
    sites: sitesOver(custody, served.origins, () => time.clock),
    raised: [],
    captured: [],
  };
  const stop = async () => {
    await custody.stop();
    await served.close();
  };
  return { site, served, given, stop };
}

/** One pass on the world's lease in a process of its own (`site-runner-child.ts`). */
async function firstPassInChild(
  id: string,
  served: Served,
): Promise<{ stdout: string; stderr: string }> {
  const handed = {
    appUrl: String(w.world.db.appUrl),
    business: w.world.business,
    actorId: lease.holder,
    claim: { correctionId: id, taskId: lease.taskId, leaseId: lease.leaseId, fence: lease.fence },
    served: { origins: served.origins, credentialsFile: served.credentialsFile },
  };
  const child = process.execPath;
  return await run(child, ['tests/site/site-runner-child.ts', JSON.stringify(handed)], {
    timeout: 120_000,
  });
}

/** Everything written to stdout and stderr while `work` runs. */
async function output<T>(work: () => Promise<T>): Promise<{ result: T; written: string }> {
  const written: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const keep = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  process.stdout.write = keep as typeof process.stdout.write;
  process.stderr.write = keep as typeof process.stderr.write;
  try {
    return { result: await work(), written: written.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** The correction's register entries and receipts as stored, whole. */
async function storedFor(id: string): Promise<string> {
  const rows = await w.world.db.admin.execute<{ readonly row: unknown }>(
    `select to_jsonb(o) as row from public.operations o where record_id = $1
     union all
     select to_jsonb(r) from public.live_correction_receipts r where correction_id = $1`,
    [id],
  );
  return JSON.stringify(rows);
}

describe.skipIf(serverUrl === undefined)('the site runner, through custody', () => {
  it('publishes with custody alone holding the credentials, and the canary reaches nothing of the runner', async () => {
    const id = await approved();
    const { site, served, given, stop } = await hosted();
    try {
      const { result, written } = await output(async () => await runnerOn(id, given).runner.pass());
      expect(result).toEqual([{ correctionId: id, outcome: 'live' }]);
      expect(merges(site)).toHaveLength(1);
      // Custody sent each entry's credential to its own provider, and nothing else did.
      expect(new Set(served.authorizations)).toEqual(
        new Set(Object.values(CANARY).map((token) => `Bearer ${token}`)),
      );
      expect(new Set(site.sent.map((sent) => sent.host))).toEqual(
        new Set(['api.github.com', 'api.vercel.com']),
      );
      for (const seen of [
        written,
        JSON.stringify(result),
        JSON.stringify(given.raised),
        await storedFor(id),
      ])
        expect(seen).not.toMatch(/canary-/u);
    } finally {
      await stop();
    }
  });
});

describe.skipIf(serverUrl === undefined)('the site runner, restarted in its own process', () => {
  it('a runner stopped after its publish, in its own process, is followed by one that never sends twice', async () => {
    const id = await approved();
    const { site, served, given, stop } = await hosted();
    building(site);
    try {
      const child = await firstPassInChild(id, served);
      expect(JSON.parse(child.stdout)).toEqual({
        passed: [{ correctionId: id, outcome: 'following' }],
        raised: [],
      });
      expect(child.stdout + child.stderr).not.toMatch(/canary-/u);
      expect(merges(site)).toHaveLength(1);

      const second = await takeOver();
      const db = connect(String(w.world.db.appUrl));
      try {
        built(site);
        expect(await runnerOn(id, given, db, second).runner.pass()).toEqual([
          { correctionId: id, outcome: 'live' },
        ]);
      } finally {
        await db.close();
        await handBack(second.leaseId);
      }
      expect(merges(site)).toHaveLength(1);
      expect(await entries(id)).toHaveLength(1);
    } finally {
      await stop();
    }
  });
});
