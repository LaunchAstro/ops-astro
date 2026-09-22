// SPDX-License-Identifier: AGPL-3.0-only
//
// The runner for this directory's DOM tests, and the reason it exists at all.
//
// The root `vitest.config.ts` collects `*.test.ts` and not `*.test.tsx`, so the
// two mounted tests here are invisible to `pnpm test`. That file is the
// coordinator's and vitest 5 has no `--include` flag to override it from the
// command line, so this config sits in the directory it serves and is selected
// explicitly:
//
//     pnpm exec vitest run --config tests/surfaces/vitest.config.ts
//
// It extends the root config rather than restating it, so the two cannot drift.
// **It is scaffolding, not a decision.** The real fix is one glob in the root
// config — `tests/**/*.test.tsx` beside `tests/**/*.test.ts` — and when that
// lands this file should be deleted rather than kept as a second way to run the
// same tests.
//
// The environment is not set here. Each DOM test carries its own
// `// @vitest-environment jsdom` docblock, so a test that needs a document says
// so in the file a reader has open.

import { mergeConfig } from 'vitest/config';
import root from '../../vitest.config.ts';

export default mergeConfig(root, {
  test: {
    include: ['tests/surfaces/**/*.test.ts', 'tests/surfaces/**/*.test.tsx'],
  },
});
