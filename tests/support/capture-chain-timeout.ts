// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser-capture proof and the proofs that run it: each runs the real
// named page capture in a browser (about 10 s here), nested up to three runs
// deep, past the 5 s default. They get one longer timeout here, so Sol's
// proofs keep their bytes (ORCH45's ruling on REVB1ENDFIXWEBC).

import { expect, vi } from 'vitest';

const captureChain = [
  'tests/visual/harness-capture-needs-browser.test.ts',
  'tests/visual/browser-proof-coloured-summary.test.ts',
  'tests/visual/coloured-browser-summary-recognises-named-capture.test.ts',
  'tests/visual/coloured-summary-fails-without-named-capture.test.ts',
  'tests/visual/coloured-summary-rejects-failed-capture.test.ts',
  'tests/visual/coloured-summary-rejects-mixed-capture-failure.test.ts',
];

const path = expect.getState().testPath ?? '';
if (captureChain.some((file) => path.endsWith(`/${file}`))) {
  vi.setConfig({ testTimeout: 120_000 });
}
