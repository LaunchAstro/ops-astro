// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- Sol's proof keeps each case's schedule in one place */
import { describe, expect, it } from 'vitest';
import { approved, at, latch, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';
import { bound } from './c80-site-ports-bound.ts';
import { line } from './c80-site-provider.ts';
import { runLivePublish } from '../../packages/core-commands/src/index.ts';

useRegisterWorld();
describe.skipIf(serverUrl === undefined)('the cap survives a late observation', () => {
  it('a deployment-less effect stays within its business, client and lease holder', async () => {
    const id = await approved();
    const { site, ports } = await bound(id);
    site.state.lookupMisses = 1000;
    expect(await runLivePublish(w.world.db.app, at(id), ports())).toMatchObject({
      state: 'accepted',
    });
    const before = site.sent.length;
    expect(await runLivePublish(w.world.db.app, at(id, w.beta), ports())).toMatchObject({
      kind: 'refused',
      code: 'LEASE_NOT_OWNED',
    });
    expect(
      await runLivePublish(w.world.db.app, { ...at(id), actorId: w.ava.actorId }, ports()),
    ).toMatchObject({ kind: 'refused', code: 'LEASE_NOT_OWNED' });
    expect(site.sent).toHaveLength(before);
    const otherClient = await bound(id, { party: () => w.partyB });
    expect(await runLivePublish(w.world.db.app, at(id), otherClient.ports())).toMatchObject({
      kind: 'refused',
      code: 'BINDING_NOT_THIS_CORRECTION',
    });
    expect(otherClient.site.sent).toEqual([]);
    expect(await w.stateOf(id)).toBe('accepted');
  });
  it('an earlier observation cannot erase the cap and cause a second person task', async () => {
    const id = await approved();
    const { site, ports, raised } = await bound(id);
    site.state.lookupMisses = 1000;
    expect(await runLivePublish(w.world.db.app, at(id), ports())).toMatchObject({
      state: 'accepted',
    });
    const [started, signalStarted] = latch();
    const [resume, signalResume] = latch();
    const earlyPorts = ports();
    const early = runLivePublish(w.world.db.app, at(id), {
      ...earlyPorts,
      findDeployment: async (revision) => {
        signalStarted();
        await resume;
        return await earlyPorts.findDeployment(revision);
      },
    });
    await started;
    try {
      expect(
        await runLivePublish(w.world.db.app, at(id), ports(), { lastPass: true }),
      ).toMatchObject({ code: 'DEPLOYMENT_NOT_FOUND', waitsOn: 'person' });
    } finally {
      signalResume();
    }
    await early;
    await runLivePublish(w.world.db.app, at(id), ports(), { lastPass: true });
    expect(
      site.sent
        .map(line)
        .filter((sent) => sent === 'PUT /repos/agency/site/contents/src/pages/about.md'),
    ).toHaveLength(1);
    expect(raised).toEqual(['DEPLOYMENT_NOT_FOUND']);
    expect(await w.stateOf(id)).toBe('unknown');
  });
});
