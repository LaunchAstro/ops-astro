// SPDX-License-Identifier: AGPL-3.0-only
//
// On CI, fails the run if a proof that must run there skipped.
//
// A test that skips without the setup it needs leaves vitest's exit code at 0,
// so a required CI step running such a proof stayed green with the proof never
// run (Sol's REV258D). Each file named here skips outside the job that gives it
// its setup. The `local checks` job runs every file with no database and names
// none, where they skip by design. A CI run with a database that includes one
// of `mustRunOnCi`, or a CI run that names one of `mustRunWhenNamed` on its
// command line, fails unless every test in it ran.

import { relative, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

const mustRunOnCi = new Set(['tests/ci/named-service-stop-proof-two-urls.test.ts']);
// Armed only by the runtime proofs' runner (`restart-proof.sh`), which names it.
const mustRunWhenNamed = new Set(['tests/acceptance/inbox-worker-restart.test.ts']);

export default function setup(project: TestProject): (() => void) | undefined {
  if (process.env['CI'] !== 'true') return undefined;
  const { root } = project.config;
  const database = (process.env['DATABASE_URL'] ?? '') !== '';
  const named = new Set(process.argv.slice(2).map((arg) => relative(root, resolve(root, arg))));
  const must = (file: string): boolean =>
    (database && mustRunOnCi.has(file)) || (mustRunWhenNamed.has(file) && named.has(file));
  return () => {
    for (const module of project.vitest.state.getTestModules()) {
      const file = relative(root, module.moduleId);
      if (!must(file)) continue;
      const states = [...module.children.allTests()].map((test) => test.result().state);
      if (states.length === 0 || states.includes('skipped')) {
        throw new Error(
          `ci must-run: ${file} did not run all its tests on CI (${states.join(', ')})`,
        );
      }
    }
  };
}
