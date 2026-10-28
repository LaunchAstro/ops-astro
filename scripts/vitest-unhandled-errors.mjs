// SPDX-License-Identifier: AGPL-3.0-only
// A vitest reporter for scripts/db-conformance.mjs: how many errors vitest
// raised outside any test, written to the file UNHANDLED_ERRORS_FILE names.
// vitest's JSON report leaves unhandled rejections and errors out (S1862-1),
// so beside a failed test they would look like a failure only its tests own,
// and the timing-failure rule would re-run it.

import { writeFileSync } from 'node:fs';

export default class UnhandledErrors {
  onTestRunEnd(_modules, unhandledErrors) {
    const file = process.env['UNHANDLED_ERRORS_FILE'];
    if (file) writeFileSync(file, String(unhandledErrors.length));
  }
}
