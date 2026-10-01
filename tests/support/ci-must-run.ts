// SPDX-License-Identifier: AGPL-3.0-only
//
// On CI with a database, fails the run if a proof that must run there skipped.
//
// A test that skips without the setup it needs leaves vitest's exit code at 0,
// so a required CI step running such a proof stayed green with the proof never
// run (Sol's REV258D). Each file named here skips outside the job that gives it
// its setup. The `local checks` job runs every file with no database, where
// they skip by design; a CI run with a database that includes one fails unless
// every test in it ran.

import { relative } from 'node:path';
import type { TestProject } from 'vitest/node';

const mustRunOnCi = new Set(['tests/ci/named-service-stop-proof-two-urls.test.ts']);

export default function setup(project: TestProject): (() => void) | undefined {
  if (process.env['CI'] !== 'true' || (process.env['DATABASE_URL'] ?? '') === '') return undefined;
  return () => {
    for (const module of project.vitest.state.getTestModules()) {
      const file = relative(project.config.root, module.moduleId);
      if (!mustRunOnCi.has(file)) continue;
      const states = [...module.children.allTests()].map((test) => test.result().state);
      if (states.length === 0 || states.includes('skipped')) {
        throw new Error(
          `ci must-run: ${file} did not run all its tests on CI (${states.join(', ')})`,
        );
      }
    }
  };
}
