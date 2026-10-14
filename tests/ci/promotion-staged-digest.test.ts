// SPDX-License-Identifier: AGPL-3.0-only
//
// #970: production gets the bytes staging ran, not merely bytes that agree
// with their own stamp. A store writer can replace `ops-astro-<version>`
// before selection with a tree of their own, stamped with the same build and
// digested consistently. The anchor is staging's web deploy record, the
// digest it handed Vercel, in the operator's own record folder
// (`OPS_ASTRO_DEPLOYMENTS/deployments.jsonl`). The promotion (real run and dry
// run) selects only an artefact whose digest that record holds for the
// version; a record outside the promotion's trust boundary, malformed or in
// disagreement is never read past. The record is judged again after the
// migration and once the link is pointed, and the last acts run only under
// the operator's held grant. The production web deploy's cases are in
// production-web-staged-digest.test.ts.

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordedStamp } from '../../scripts/ops/build-output.ts';
import {
  promote,
  type PromotionEffects,
  type PromotionRequest,
} from '../../scripts/ops/promotion.ts';
import {
  each,
  LINE,
  named,
  records,
  replaced,
  scratch,
  staged,
  stagingLine,
  STAGED,
  store,
} from './promotion.fixture.ts';

const COMMAND = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;

/** Effects that note every call; `during` runs inside the named effect. */
const watched = (during: { migrate?: () => void; point?: () => void } = {}) => {
  const calls: string[] = [];
  const effects: PromotionEffects = {
    services: () => {
      calls.push('services');
      return [
        { manager: 'docker', name: 'prod-api', running: false },
        { manager: 'docker', name: 'prod-auth', running: false },
      ];
    },
    migrate: () => {
      calls.push('migrate');
      during.migrate?.();
      return true;
    },
    point: (_at, served) => {
      calls.push(`point ${served}`);
      during.point?.();
    },
    start: (service) => calls.push(`start ${service.name}`),
    authorised: async (work) => {
      calls.push('authorised');
      return await work();
    },
  };
  return { calls, effects };
};

let currents = 0;
const request = (over: Partial<PromotionRequest> & { records: string }): PromotionRequest => {
  currents += 1;
  return {
    version: STAGED,
    store: store({ [named(STAGED)]: STAGED }),
    line: LINE,
    dryRun: false,
    api: { manager: 'docker', name: 'prod-api' },
    auth: { manager: 'docker', name: 'prod-auth' },
    current: join(scratch, `current${String(currents)}`),
    ...over,
  };
};

const refusedAtSelection = async (
  over: Partial<PromotionRequest> & { records: string },
  reason: RegExp,
) => {
  await each([false, true], async (dryRun) => {
    const { calls, effects } = watched();
    const outcome = await promote(request({ ...over, dryRun }), effects);
    expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(reason) });
    expect(calls).toStrictEqual([]);
  });
};

/** The digest the stored artefact for STAGED records in its own stamp. */
const recordedDigest = (root: string): string =>
  String(recordedStamp(join(root, named(STAGED))).digest);

describe('the promotion selects only the bytes staging ran', () => {
  it('promotes the artefact whose digest staging recorded for the version', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const { calls, effects } = watched();
    const outcome = await promote(request({ store: root, records: staged(root) }), effects);
    expect(outcome.kind).toBe('promoted');
    expect(calls).toContain('migrate');
  });

  it('refuses a self-consistent tree put in the store after staging recorded its own, real run and dry run', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const recorded = staged(root);
    replaced(root);
    await refusedAtSelection({ store: root, records: recorded }, /is not the bytes staging ran/u);
  });

  it('refuses when no record folder is named, or the folder or its file is missing', async () => {
    await refusedAtSelection({ records: '' }, /staging's record folder/u);
    await refusedAtSelection({ records: join(scratch, 'no-such-folder') }, /is missing/u);
    const empty = records([]);
    rmSync(join(empty, 'deployments.jsonl'));
    await refusedAtSelection({ records: empty }, /deployments\.jsonl is missing/u);
  });

  it('refuses when staging has no web deploy record of the version', async () => {
    const other = stagingLine('fedcba987654', `sha256:${'0'.repeat(64)}`);
    const production = { ...stagingLine(STAGED, OTHER_DIGEST), environment: 'production' };
    // Staging's M5 deploy records the version with no digest: it serves no artefact bytes.
    const m5 = { action: 'deploy recorded', environment: 'staging', version: STAGED };
    await each([[], [other], [production], [m5]], async (lines) => {
      await refusedAtSelection({ records: records(lines) }, /staging has no record of deploying/u);
    });
  });
});

describe('the promotion refuses a record that does not settle the version', () => {
  it('refuses when staging recorded two different digests for one version', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const first = stagingLine(STAGED, recordedDigest(root));
    replaced(root);
    // Staging ran the replaced tree too, under the same build.
    const both = records([first, stagingLine(STAGED, recordedDigest(root))]);
    await refusedAtSelection({ store: root, records: both }, /disagree/u);
  });

  it('refuses a line that does not parse, or a recorded digest of the wrong shape', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const good = stagingLine(STAGED, recordedDigest(root));
    const torn = records([good, '{"action":"deploy rec']);
    await refusedAtSelection({ store: root, records: torn }, /line 2/u);
    await each([42, 'sha256:short', `md5:${'a'.repeat(64)}`], async (digest) => {
      const shaped = records([good, stagingLine(STAGED, digest)]);
      await refusedAtSelection({ store: root, records: shaped }, /digest/u);
    });
  });
});

describe('the promotion believes only a record inside its trust boundary', () => {
  it('refuses a linked file or folder, and group or other write on the file, the folder or above', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const real = staged(root);
    const linked = records([]);
    rmSync(join(linked, 'deployments.jsonl'));
    symlinkSync(join(real, 'deployments.jsonl'), join(linked, 'deployments.jsonl'));
    await refusedAtSelection({ store: root, records: linked }, /is a link/u);
    const viaLink = join(scratch, `records-link-${String(currents)}`);
    symlinkSync(real, viaLink);
    await refusedAtSelection({ store: root, records: viaLink }, /is a link/u);

    const writable = staged(root);
    chmodSync(join(writable, 'deployments.jsonl'), 0o620);
    await refusedAtSelection({ store: root, records: writable }, /written by others/u);
    const open = staged(root);
    chmodSync(open, 0o770);
    await refusedAtSelection({ store: root, records: open }, /written by others/u);
    // A folder above the record folder that others can write.
    const parent = records([]);
    const below = join(parent, 'below');
    mkdirSync(below, { mode: 0o700 });
    const line = JSON.stringify(stagingLine(STAGED, recordedDigest(root)));
    appendFileSync(join(below, 'deployments.jsonl'), `${line}\n`, { mode: 0o600 });
    chmodSync(parent, 0o770);
    await refusedAtSelection({ store: root, records: below }, /written by others/u);
  });

  it('refuses a record that is a pipe or a folder, without waiting on the pipe', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const piped = records([]);
    rmSync(join(piped, 'deployments.jsonl'));
    expect(spawnSync('mkfifo', [join(piped, 'deployments.jsonl')]).status).toBe(0);
    await refusedAtSelection({ store: root, records: piped }, /not a regular file/u);
    const folder = records([]);
    rmSync(join(folder, 'deployments.jsonl'));
    mkdirSync(join(folder, 'deployments.jsonl'));
    await refusedAtSelection({ store: root, records: folder }, /not a regular file/u);
  });
});

describe('the promotion judges staging’s record again after its waits', () => {
  it('a conflicting or torn line appended during the migration points and starts nothing', async () => {
    await each([stagingLine(STAGED, OTHER_DIGEST), '{"torn'], async (appended) => {
      const root = store({ [named(STAGED)]: STAGED });
      const folder = staged(root);
      const line = typeof appended === 'string' ? appended : JSON.stringify(appended);
      const append = () => appendFileSync(join(folder, 'deployments.jsonl'), `${line}\n`);
      const { calls, effects } = watched({ migrate: append });
      const outcome = await promote(request({ store: root, records: folder }), effects);
      expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/staging/u) });
      expect(calls.filter((call) => /^(point|start)/u.test(call))).toStrictEqual([]);
    });
  });

  it('a conflicting line appended as the link is pointed fails the promotion unrecorded', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const folder = staged(root);
    const line = JSON.stringify(stagingLine(STAGED, OTHER_DIGEST));
    const append = () => appendFileSync(join(folder, 'deployments.jsonl'), `${line}\n`);
    const { effects } = watched({ point: append });
    const outcome = await promote(request({ store: root, records: folder }), effects);
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/changed during the promotion/u),
    });
  });
});

describe('the promotion acts only while staging’s record and the operator still hold', () => {
  it('an unrelated line appended during the migration still promotes', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const folder = staged(root);
    const line = JSON.stringify(stagingLine('fedcba987654', OTHER_DIGEST));
    const append = () => appendFileSync(join(folder, 'deployments.jsonl'), `${line}\n`);
    const { effects } = watched({ migrate: append });
    const outcome = await promote(request({ store: root, records: folder }), effects);
    expect(outcome.kind).toBe('promoted');
  });

  it('points and starts nothing once the operator is no longer admitted', async () => {
    const root = store({ [named(STAGED)]: STAGED });
    const { calls, effects } = watched();
    const refusing: PromotionEffects = {
      ...effects,
      authorised: () => Promise.reject(new Error('the operator no longer holds operations:manage')),
    };
    const outcome = await promote(request({ store: root, records: staged(root) }), refusing);
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/no longer holds operations:manage/u),
    });
    expect(calls.filter((call) => /^(point|start)/u.test(call))).toStrictEqual([]);
  });
});

describe('the promotion command takes staging’s record folder from the environment', () => {
  const run = (env: Record<string, string | undefined>, artefacts: string) => {
    const result = spawnSync(
      process.execPath,
      [COMMAND, '--dry-run', '--version', STAGED, '--artefacts', artefacts, '--line', LINE],
      { encoding: 'utf8', env: { ...process.env, OPS_ASTRO_DEPLOYMENTS: undefined, ...env } },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  it('dry-runs only over an artefact staging recorded', () => {
    const root = store({ [named(STAGED)]: STAGED });
    const recorded = staged(root);
    const ran = run({ OPS_ASTRO_DEPLOYMENTS: recorded }, root);
    expect(ran.status, ran.out).toBe(0);
    const unnamed = run({}, root);
    expect(unnamed.status, unnamed.out).toBe(1);
    expect(unnamed.out).toMatch(/OPS_ASTRO_DEPLOYMENTS/u);
    replaced(root);
    const swapped = run({ OPS_ASTRO_DEPLOYMENTS: recorded }, root);
    expect(swapped.status, swapped.out).toBe(1);
    expect(swapped.out).toMatch(/is not the bytes staging ran/u);
  }, 60_000);
});
