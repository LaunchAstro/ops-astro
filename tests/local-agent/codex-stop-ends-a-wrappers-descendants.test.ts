// SPDX-License-Identifier: AGPL-3.0-only
//
// The Codex executable is configurable, so it may be a wrapper that starts the
// real model process and waits for it. A call stopped at its deadline is
// charged as unknown and its home let go, so nothing it started may go on
// running: the stop ends the wrapper's whole process group, not only the
// process the runner spawned.

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { runCodex, UNKNOWN } from '../../apps/local-agent/codex.ts';
import type { RunnerSettings } from '../../apps/local-agent/settings.ts';

const root = mkdtempSync(join(tmpdir(), 'codex-wrapper-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

it('a call stopped at its deadline leaves nothing its wrapper started running', async () => {
  const marker = join(root, 'descendant-ran');
  const wrapper = join(root, 'codex-wrapper.sh');
  // The descendant inherits the output and writes its marker two seconds on.
  writeFileSync(wrapper, `#!/bin/sh\n(sleep 2; echo ran > '${marker}') &\nwait\n`);
  chmodSync(wrapper, 0o700);
  const home = join(root, 'runner');
  const settings: RunnerSettings = {
    key: 'k',
    home,
    codexHome: join(home, 'codex-home'),
    codexBin: wrapper,
    capTokens: 1_000_000,
    capConfigured: false,
    childEnv: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: join(home, 'child-home'),
      LANG: 'C',
      USER: 'runner',
      LOGNAME: 'runner',
    },
    timeoutMs: 1_000,
  };

  expect(await runCodex(settings, 'gpt-5', 'Hello')).toBe(UNKNOWN);
  await sleep(2_500);
  expect(existsSync(marker), 'the wrapper started a process that outlived the stop').toBe(false);
}, 10_000);
