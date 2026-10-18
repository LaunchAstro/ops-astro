// SPDX-License-Identifier: AGPL-3.0-only
//
// #1696: a site deployment the hosting provider shows no record of within the
// publish's lookup window is not published yet, never unknown. The correction
// stays accepted with its commit, and each later pass of the host looks the
// deployment up again by that commit. Unknown stays for a deployment found
// for another commit, one that does not serve the page, and one still not
// found at the host's last pass, which asks a person once. No case sends the
// publish twice. Every provider is a double: nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { APPROVED, MERGED, PAGE, SEAM, binding, line, proposed } from './c80-site-provider.ts';
import { bound } from './c80-site-ports-bound.ts';
import {
  approved,
  at,
  entries,
  receipt,
  serverUrl,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';
import { mergeAndFind, revertForward } from '../../packages/core-connectors/src/index.ts';
import { runLivePublish, type RunnerPorts } from '../../packages/core-commands/src/index.ts';

useRegisterWorld();

const WRITE = 'PUT /repos/agency/site/contents/src/pages/about.md';
const LOOKUP = 'GET /v6/deployments?projectId=prj_site&sha=c0ffee02&target=production&limit=1';

/** One pass of the host: the runner on fresh ports, its last pass when `lastPass`. */
const pass = async (id: string, ports: RunnerPorts, lastPass = false) =>
  await runLivePublish(w.world.db.app, at(id), ports, { lastPass });

describe.skipIf(serverUrl === undefined)(
  'a slow site deployment reads as not published yet',
  () => {
    it('a deployment appearing after 40 s reads accepted, then live, from one publish', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      // Six lookups 5 s apart at the publish and one as it is observed, one more at the host's
      // next pass (40 s), and found at the pass after.
      site.state.lookupMisses = 8;
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(site.waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
      expect((await receipt(id, 'publish'))['deployment_id']).toEqual({
        observed: 'not found yet',
      });
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      expect((await receipt(id, 'publish'))['deployment_id']).toEqual({ observed: 'dpl_merged' });
      expect(site.sent.map(line).filter((sent) => sent === WRITE)).toHaveLength(1);
      expect(site.sent.map(line).filter((sent) => sent === LOOKUP)).toHaveLength(9);
      expect([raised, (await entries(id)).length, site.waits.length]).toEqual([[], 1, 5]);
    });

    it('a deployment that never appears ends unknown at the last pass, with one person task', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.lookupMisses = 1_000;
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(await pass(id, ports(), true)).toMatchObject({
        kind: 'refused',
        code: 'DEPLOYMENT_NOT_FOUND',
        waitsOn: 'person',
      });
      expect(await w.stateOf(id)).toBe('unknown');
      // A host restarted at its cap passes last again: still one task, still one publish.
      expect(await pass(id, ports(), true)).toMatchObject({ code: 'DEPLOYMENT_NOT_FOUND' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_FOUND']);
      expect(site.sent.map(line).filter((sent) => sent === WRITE)).toHaveLength(1);
      expect((await entries(id)).length).toBe(1);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a slow site deployment still ends unknown where it is not this one serving',
  () => {
    it('a different deployment taking the alias still ends DEPLOYMENT_NOT_SERVING, unknown', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.lookupMisses = 8;
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      site.state.production = 'dpl_other';
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
      expect((await receipt(id, 'publish'))['deployment_id']).toEqual({ observed: 'dpl_merged' });
      expect(site.sent.map(line).filter((sent) => sent === WRITE)).toHaveLength(1);
    });

    it('a deployment found for another commit at a later pass is unknown, never live', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.lookupMisses = 7;
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'accepted' });
      site.state.lookupCommit = 'c0ffee99';
      expect(await pass(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_COMMIT_MISMATCH']);
      expect(site.sent.map(line).filter((sent) => sent === WRITE)).toHaveLength(1);
    });
  },
);

describe('the publish binding', () => {
  it('answers a written commit with no deployment found yet without a deployment, not unknown', async () => {
    const site = proposed();
    site.state.lookupMisses = 6;
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toEqual({
      kind: 'ok',
      value: { revision: MERGED, liveUrl: PAGE },
    });
    expect(site.waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(site.sent.map(line).filter((sent) => sent === WRITE)).toHaveLength(1);
  });

  it('leaves a revert whose deployment is not found unknown, as before (not this ticket)', async () => {
    const site = proposed();
    expect(await mergeAndFind(binding, APPROVED, site.deps)).toMatchObject({ kind: 'ok' });
    site.state.lookupMisses = 6;
    expect(await revertForward(binding, { seam: SEAM }, site.deps)).toEqual({
      kind: 'unknown',
      code: 'DEPLOYMENT_NOT_FOUND',
    });
  });
});
