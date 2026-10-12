// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5 deploy records a unit only when each container runs its pinned image:
// a live process, not one that stopped after Compose waited or waits in
// Docker's restart backoff. Each case runs deploy.mjs's own effects against a
// docker whose `inspect` answers as `.State` reads (Sol's PR #1357 findings).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DeployEffects,
  deploy,
  type StagingDefinition,
  withWorker,
} from '../../scripts/ops/deploy.ts';
import { clean, live, snapshot, STAGED, store } from './staging-deploy.fixture.ts';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const whole = withWorker(
  JSON.parse(read('deploy/production/compose.json')) as StagingDefinition,
  JSON.parse(read('deploy/production/worker.json')) as Pick<StagingDefinition, 'services'>,
);
const containersOf = (definition: StagingDefinition): Record<string, string> =>
  Object.fromEntries(
    Object.values(definition.services).map((s) => [s.container_name, String(s.image)]),
  );

/** A deploy whose Docker reports every container on its pinned image, the worker in `state`. */
async function deployWithWorker(state: string) {
  const containers = Object.values(whole.services).map((s) => String(s.container_name));
  // deploy.mjs's own effects; Docker answers `inspect` as `.State` reads:
  // Running, Restarting, Pid.
  const body = /const effects = (\{[\s\S]*?\n\});/u.exec(read('scripts/ops/deploy.mjs'))?.[1];
  const inspect = containers
    .map((name) => {
      const running = name === 'ops-astro-worker' ? state : 'true false 4242';
      return `/${name} ${containersOf(whole)[name]} ${running}`;
    })
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
    { version: STAGED, store: store(), worker: true },
    { ...machine, imageId: (ref) => ref },
    clean,
    'production',
  );
}

describe("the deploy reads each container's running state", () => {
  it('records the unit when the worker has a live process', async () => {
    expect(await deployWithWorker('true false 4243')).toMatchObject({ kind: 'deployed' });
  });

  it('fails when the worker stopped after Compose waited, though its image matches', async () => {
    const outcome = await deployWithWorker('false false 0');
    expect(outcome.kind === 'failed' && outcome.reason).toContain('ops-astro-worker runs nothing');
  });

  it('fails when the worker waits in restart backoff, running with no process', async () => {
    const outcome = await deployWithWorker('true true 0');
    expect(outcome.kind === 'failed' && outcome.reason).toContain('ops-astro-worker runs nothing');
  });
});
