import { describe, expect, it } from 'vitest';
import {
  createSiteRunner,
  FOLLOW_FOR_MS,
  type Claim,
  type SiteRunnerDeps,
} from '../../apps/site-runner/runner.ts';
import { approved, lease, serverUrl, w } from './c80-register-world.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { requestBody } from './c80-world.ts';
import { B_PAGE, B_FILE } from './c80-sites.ts';
import { building, time, useRunnerWorld, world, writes } from './site-runner-world.ts';

useRunnerWorld();

function runnerFor(
  id: string,
  given: ReturnType<typeof world>,
  overrides: Partial<SiteRunnerDeps>,
) {
  let taken = false;
  const claim: Claim = {
    correctionId: id,
    taskId: lease.taskId,
    leaseId: lease.leaseId,
    fence: lease.fence,
  };
  return createSiteRunner({
    db: w.world.db.app,
    business: w.world.business,
    actorId: lease.holder,
    sites: given.sites,
    claims: {
      take: () => Promise.resolve(taken ? [] : ((taken = true), [claim])),
      beat: () => Promise.resolve(true),
      release: () => Promise.resolve(),
    },
    raiseTask: (_claim, reason) => {
      given.raised.push(reason);
      return Promise.resolve();
    },
    now: () => time.clock,
    ...overrides,
  });
}

describe.skipIf(serverUrl === undefined)('Sol PR1758 separation', () => {
  it('Sol proof, criterion 2: another business cannot read or send a held correction', async () => {
    const id = await approved();
    const given = world();
    const runner = runnerFor(id, given, { business: w.beta as SiteRunnerDeps['business'] });
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'LEASE_LOST' }]);
    expect(given.site.sent).toEqual([]);
    expect(await w.receiptsOf(id)).toBe(0);
  });
  it('Sol proof, criterion 2: another actor cannot exercise the lease', async () => {
    const id = await approved();
    const given = world();
    const runner = runnerFor(id, given, { actorId: w.ben.actorId });
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'LEASE_LOST' }]);
    expect(given.site.sent).toEqual([]);
    expect(await w.receiptsOf(id)).toBe(0);
  });
  it('Sol proof, criterion 2: another client correction cannot use the lease', async () => {
    const detail = detailOf(
      await w.request(w.ava, { ...requestBody(w.partyB, w.taskB), pageUrl: B_PAGE, path: B_FILE }),
    );
    const id = String(detail['correctionId']);
    expect(id).not.toBe('undefined');
    await w.approve(w.ben, id, String(detail['versionId']));
    const given = world();
    const runner = runnerFor(id, given, {});
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'NOT_FOUND' }]);
    expect(writes(given.site)).toEqual([]);
    expect(await w.receiptsOf(id)).toBe(0);
  });
});

describe.skipIf(serverUrl === undefined)('Sol PR1758 deadline', () => {
  it('Sol proof, criterion 1: ten minutes are measured from first accepted observation', async () => {
    const id = await approved();
    const given = world();
    building(given.site);
    let initial = true;
    const sites = {
      ...given.sites,
      publish: (...args: Parameters<typeof given.sites.publish>) => {
        const ports = given.sites.publish(...args);
        return {
          ...ports,
          readDeployment: async (deployment: string) => {
            // The first publish and provider observation consume five seconds.
            if (initial) {
              initial = false;
              time.clock += 5_000;
            }
            return await ports.readDeployment(deployment);
          },
        };
      },
    };
    const runner = runnerFor(id, given, { sites });
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    const acceptedAt = time.clock;
    time.clock = acceptedAt + FOLLOW_FOR_MS - 1;
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'following' }]);
    expect(given.raised).toEqual([]);
  });
});
