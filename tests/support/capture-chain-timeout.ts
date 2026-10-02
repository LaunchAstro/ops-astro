// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser-capture proof and the proofs that run it: each runs the real
// named page capture in a browser, nested up to three runs deep, past the 5 s
// default. They get one longer timeout here, so Sol's proofs keep their bytes
// (ORCH45's ruling on REVB1ENDFIXWEBC).
//
// The capture photographs every built page at three widths in two themes, so
// it grows with the app: 48 pictures took 38 s on the hosted Linux runner, 72
// took 120 s. A wrapper that gives up before the capture's own budget fails a
// capture that is still within it, so the chain waits out that budget (600 s in
// tests/surfaces/mp-1-1-tokens.test.tsx) plus a minute for the nested starts.

import { expect, vi } from 'vitest';

/** How long a proof in the chain waits: the named capture's own budget, plus the nested starts. */
export const CAPTURE_CHAIN_TIMEOUT = 660_000;

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
  vi.setConfig({ testTimeout: CAPTURE_CHAIN_TIMEOUT });
}
