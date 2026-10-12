// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 deploy records a unit only when each container runs its pinned image:
// a container Docker reports as running, not one that stopped after Compose
// waited, waits in restart backoff or was paused. Each case runs deploy.mjs's
// own effects against a docker whose `inspect` answers with `.State.Status`
// (Sol's PR #1357 findings), for the forwarder of production's parked unit.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DeployEffects, deploy, type StagingDefinition } from '../../scripts/ops/deploy.ts';
import { clean, live, snapshot, STAGED, store } from './staging-deploy.fixture.ts';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const unit = JSON.parse(read('deploy/production/compose.json')) as StagingDefinition;
const images: Record<string, string> = Object.fromEntries(
  Object.values(unit.services).map((s) => [s.container_name, String(s.image)]),
);

/** A deploy whose Docker reports every container on its pinned image, the forwarder in `status`. */
async function deployWithForwarder(status: string) {
  const containers = Object.keys(images);
  // deploy.mjs's own effects; Docker answers `inspect` with `.State.Status`.
  const body = /const effects = (\{[\s\S]*?\n\});/u.exec(read('scripts/ops/deploy.mjs'))?.[1];
  const inspect = containers
    .map(
      (name) => `/${name} ${images[name]} ${name === 'ops-astro-forwarder' ? status : 'running'}`,
    )
    .join('\n');
  const docker = (_command: string, args: string[]) =>
    args[0] === 'inspect' ? { status: 0, stdout: `${inspect}\n` } : { status: 1, stdout: '' };
  const machine = new Function(
    'snapshot',
    'compare',
    'execFileSync',
    'spawnSync',
    'containers',
    `return (${String(body)});`,
  )(
    () => snapshot([live]),
    () => ({ unchanged: true, report: '' }),
    () => {},
    docker,
    containers,
  ) as DeployEffects;
  return await deploy(
    { version: STAGED, store: store() },
    { ...machine, imageId: (ref) => ref },
    clean,
    'production',
  );
}

describe("the deploy reads each container's running state", () => {
  it('records the parked unit when every container runs', async () => {
    expect(await deployWithForwarder('running')).toMatchObject({ kind: 'deployed' });
  });

  for (const status of ['exited', 'restarting', 'paused']) {
    it(`fails when a container is ${status} after Compose waited, though its image matches`, async () => {
      const outcome = await deployWithForwarder(status);
      expect(outcome.kind === 'failed' && outcome.reason).toContain(
        'ops-astro-forwarder runs nothing',
      );
    });
  }
});
