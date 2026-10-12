// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof (round 3 on #1368, #1395): one recurring tick keeps one
// silent-provider set across every business it passes, so a provider that
// timed out for the first business is not asked again for the second.
import { expect, it as vitestIt } from 'vitest';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import * as recovery from '../../apps/api/recovery-entry.ts';
import { REPLAY_LOOKUP_PATH } from '../../packages/core-connectors/src/index.ts';
import { reconcileProviderCalls } from '../../packages/core-custody/src/index.ts';
import { callerAudit } from '../../packages/core-commands/src/index.ts';
import { dropped, faultBroker, s, useFaultWorld, world } from './aw-10-world.ts';
import { noDatabase } from './broker-world.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useFaultWorld('sol1368providers');

it('Sol proof, criterion correctness: one recurring pass asks a silent provider only once across businesses', async () => {
  const bravo = await seedSchedules(s.db, 'sol1368providers-bravo', 1_000_000);
  await openBilling(bravo);
  await dropped('unavailable', s);
  await dropped('unavailable', bravo);
  world.provider.lookupMode('slow');
  const before = world.provider.seen.filter(
    (request) => request.path === REPLAY_LOOKUP_PATH,
  ).length;
  const broker = { ...faultBroker(), audit: callerAudit };
  const legacy = Reflect.get(recovery, 'passEachBusiness') as
    | ((...args: Parameters<typeof passDeployment>) => Promise<readonly recovery.RecoveryOutcome[]>)
    | undefined;
  const answer = await (legacy ?? passDeployment)(
    s.db.app,
    async (key) => (key === 'alpha' ? s.business : bravo.business),
    ['alpha', 'bravo'],
    registerEffectLookup,
    async (database, businessId, unanswered) =>
      await reconcileProviderCalls(database, businessId, broker, unanswered),
  );
  const outcomes = Array.isArray(answer) ? answer : [answer];
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  expect(outcomes.flatMap((outcome) => (outcome.ok ? outcome.businesses : []))).toHaveLength(2);
  const sent =
    world.provider.seen.filter((request) => request.path === REPLAY_LOOKUP_PATH).length - before;
  expect(sent, 'the second business retried the provider that already timed out in this pass').toBe(
    1,
  );
}, 30_000);
