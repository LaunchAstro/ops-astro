// SPDX-License-Identifier: AGPL-3.0-only
//
// A separate process for the P1a generation-fence proof: it takes the plan
// token lock, reads the record and commits a new `ready` under that hold. Its
// exit code is 0 only when the commit was `durable`. It prints nothing.

import {
  commitTokenFile,
  readTokenFileLocked,
} from '../../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../../packages/core-custody/src/token-lock.ts';
import { HOUR, T0, tokens } from './plan-token-world.ts';

const file = process.argv[2] ?? '';
const out = await withTokenLock(file, { deadlineAt: Date.now() + 2_000 }, (held) => {
  readTokenFileLocked(held, file);
  return Promise.resolve(
    commitTokenFile(held, file, { state: 'ready', tokens: tokens('child', T0 + HOUR) }),
  );
});
process.exitCode = out.held && out.value === 'durable' ? 0 : 1;
