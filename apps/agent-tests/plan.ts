// SPDX-License-Identifier: AGPL-3.0-only

import type { ProcessCustody } from '../../packages/core-custody/src/agent.ts';
import { runSet, type CaseSet, type Results } from './harness.ts';

export async function runPlanSet(set: CaseSet, _custody: ProcessCustody): Promise<Results> {
  return await runSet(set);
}
