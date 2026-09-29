// SPDX-License-Identifier: AGPL-3.0-only
// S0-6d: the staging deploy (ticket S0-6). A person's act under
// `operations:manage` (the operator gate, `S0-6 operator only` in
// tests/ci/operator-only.test.ts). It deploys the artefact the store holds for
// the version asked, never a fresh build: one image built from that artefact
// on the pinned base, named to Compose by its image id. Every other service
// runs by a digest recorded in docs/supply-chain-pins.md, and a container
// found on any other image fails the deploy (`S0-6 image pins`). The machine's
// live services are snapshotted before and after through the service report,
// and one that stopped, restarted or changed fails it (`S0-6 services
// unchanged`). Only a deploy that passes all of that returns `deploy recorded`
// with the version and the image id.
//
// The decisions are tested through `deploy` with its effects watched.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_IMAGE_PLACEHOLDER, deploy, imagePinProblems } from '../../scripts/ops/deploy.ts';
import {
  definition,
  record,
  STAGED,
  PG,
  scratch,
  withImages,
  snapshot,
  live,
  expected,
  effects,
} from './staging-deploy.fixture.ts';

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let stores = 0;

/** An artefact store holding one stamped build. */
const store = (version = STAGED, stamp = version): string => {
  stores += 1;
  const root = join(scratch, `store-${stores}`);
  const build = join(root, definition['x-ops-astro'].artefact.replace('{version}', version));
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'build.json'), JSON.stringify({ build: stamp }));
  return root;
};

// ---- S0-6 image pins ------------------------------------------------------

describe('S0-6 image pins', () => {
  imagePinsCases1();
  imagePinsCases2();
  imagePinsCases3();
});

// ---- S0-6 services unchanged ----------------------------------------------

describe('S0-6 services unchanged', () => {
  it('snapshots the live services before and after, and deploys between them', () => {
    const watched = effects();
    const outcome = deploy({ version: STAGED, store: store() }, watched);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('deployed');
    const pinned =
      Object.keys(definition.services).length -
      (definition['x-ops-astro'].appServices ?? []).length;
    expect(watched.calls).toStrictEqual([
      'snapshot',
      'buildImage',
      'up',
      'runningImages',
      ...Array.from({ length: pinned }, () => 'imageId'),
      'snapshot',
      'compare',
    ]);
  });

  it('a live service that changed fails the deploy, names the report, and records nothing', () => {
    let taken = 0;
    const watched = effects({
      snapshot: () => snapshot([{ ...live, started: taken++ === 0 ? 't1' : 't2' }]),
      compare: () => ({ unchanged: false, report: 'service-report: RESTARTED docker prod-api' }),
    });
    const outcome = deploy({ version: STAGED, store: store() }, watched);
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('RESTARTED docker prod-api') });
  });

  it('a before snapshot that cannot be taken deploys nothing', () => {
    const watched = effects({
      snapshot: () => {
        throw new Error('docker is not answering');
      },
    });
    expect(() => deploy({ version: STAGED, store: store() }, watched)).toThrow();
    expect(watched.calls).toStrictEqual(['snapshot']);
  });
});

function imagePinsCases1() {
  it('every service staging runs, the auth server included, is named by a recorded digest', () => {
    expect(imagePinProblems(definition, record)).toStrictEqual([]);
    const pinned = Object.entries(definition.services).filter(
      ([name]) => !(definition['x-ops-astro'].appServices ?? []).includes(name),
    );
    expect(pinned.map(([name]) => name)).toEqual(expect.arrayContaining(['db', 'auth']));
  });

  it('an app service is named only by the image the deploy builds', () => {
    expect(
      imagePinProblems(withImages({ db: PG, api: APP_IMAGE_PLACEHOLDER }), record),
    ).toStrictEqual([]);
    for (const image of ['node:24', `node:24@sha256:${'b'.repeat(64)}`, undefined]) {
      expect(
        imagePinProblems(withImages({ db: PG, api: image }), record),
        String(image),
      ).not.toStrictEqual([]);
    }
  });
}

function imagePinsCases2() {
  it('a movable, unrecorded, hostile or missing image is refused', () => {
    const digest = 'b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
    const hostile = [
      'postgres:17-alpine',
      'postgres',
      `postgres@sha256:${digest}`,
      `postgres:18-alpine@sha256:${digest}`,
      `library/postgres:17-alpine@sha256:${digest}`,
      `postgres:17-alpine@sha256:${'c'.repeat(64)}`,
      `postgres:17-alpine@SHA256:${digest}`,
      `postgres:17-alpine@sha256:${digest.toUpperCase()}`,
      `postgres:17-alpine@sha256:${digest.slice(1)}`,
      `postgres:17-alpine@sha256:${digest} `,
      ` postgres:17-alpine@sha256:${digest}`,
      `postgres:17-alpine@sha256:${digest}\n`,
      `postgres:17-alpine\t@sha256:${digest}`,
      '${STAGING_DB_IMAGE}',
      `\${IMAGE:-postgres:17-alpine@sha256:${digest}}`,
      `postgres:17-alpine@sha256:${digest}@sha256:${digest}`,
      `pоstgres:17-alpine@sha256:${digest}`,
      APP_IMAGE_PLACEHOLDER,
      42,
      null,
      undefined,
    ];
    for (const image of hostile) {
      const problems = imagePinProblems(
        withImages({ db: image, api: APP_IMAGE_PLACEHOLDER }),
        record,
      );
      expect(problems, JSON.stringify(image)).toHaveLength(1);
      expect(problems[0], JSON.stringify(image)).toMatch(/^db: /u);
    }
  });

  it('a service Compose would build, or one with a platform override, is refused', () => {
    for (const extra of [{ build: '.' }, { platform: 'linux/amd64' }, { pull_policy: 'build' }]) {
      const def = withImages({ db: PG, api: APP_IMAGE_PLACEHOLDER });
      Object.assign(def.services['db']!, extra);
      expect(imagePinProblems(def, record), JSON.stringify(extra)).toHaveLength(1);
    }
  });
}

function imagePinsCases3() {
  it('a digest recorded only in prose, not in a pin row, is not recorded', () => {
    const prose = `The table below lists pins. postgres 17-alpine sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24.`;
    expect(
      imagePinProblems(withImages({ db: PG, api: APP_IMAGE_PLACEHOLDER }), prose),
    ).toHaveLength(1);
  });

  it('a container found on another image fails the deploy, and nothing is recorded', () => {
    const moved = effects({
      runningImages: () => ({
        ...expected(),
        'ops-astro-staging-db': `sha256:${'d'.repeat(64)}`,
      }),
    });
    const outcome = deploy({ version: STAGED, store: store() }, moved);
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('ops-astro-staging-db') });
    expect(outcome).not.toHaveProperty('record');
  });

  it('a pinned image that is not there to inspect fails the deploy', () => {
    const outcome = deploy(
      { version: STAGED, store: store() },
      effects({ imageId: () => undefined }),
    );
    expect(outcome.kind).toBe('failed');
  });
}
