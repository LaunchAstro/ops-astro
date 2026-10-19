// SPDX-License-Identifier: AGPL-3.0-only
//
// A6 fails closed (#1623 R8). The confined suite
// (`agent-loop-reaches-no-network.confined.ts`) run without its wrapper, or
// under a broken one that writes a receipt of its own and leaves the suite
// unconfined, refuses and passes nothing; and the wrapper refuses before
// anything runs when `unshare` is missing. As root on Linux, the wrapper is
// also run with a `setpriv` that drops nothing and an `unshare` that makes no
// namespace, and refuses each. No database.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const VITEST = join(root, 'node_modules/vitest/vitest.mjs');
const CONFIG = 'scripts/proofs/agent-egress.vitest.config.ts';
const WRAPPER = join(root, 'scripts/proofs/agent-egress-conformance.sh');
const temp = mkdtempSync(join(tmpdir(), 'a6-fail-closed-'));
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** This process's environment without the outer run's vitest or receipt. */
const clean = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith('VITEST') && entry[0] !== 'A6_RECEIPT',
    ),
  );

interface Ran {
  readonly status: number | null;
  readonly said: string;
  readonly passed: number;
}

let runs = 0;
/** The confined suite under its own config, as a wrapper would start it. */
function confinedSuite(env: Record<string, string>): Ran {
  runs += 1;
  const report = join(temp, `report-${String(runs)}.json`);
  const ran = spawnSync(
    process.execPath,
    [VITEST, 'run', '--config', CONFIG, '--reporter=json', `--outputFile=${report}`],
    { cwd: root, env: { ...clean(), ...env, TMPDIR: temp }, encoding: 'utf8', timeout: 120_000 },
  );
  const json = existsSync(report) ? readFileSync(report, 'utf8') : '{}';
  const passed = (JSON.parse(json) as { numPassedTests?: number }).numPassedTests ?? 0;
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}${json}`, passed };
}

function wrapper(path: string): { readonly status: number | null; readonly said: string } {
  const ran = spawnSync('/bin/bash', [WRAPPER], {
    cwd: root,
    env: { ...clean(), PATH: path, TMPDIR: temp },
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
}

const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

/** A command that skips its options to `--` and runs the rest as it is. */
function shim(name: string): string {
  const dir = join(temp, `shim-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
  chmodSync(join(dir, name), 0o755);
  return `${dir}:${process.env['PATH'] ?? ''}`;
}

/** The receipt a broken wrapper writes for itself: every fact claimed, none of it so. */
function forgedReceipt(): string {
  const forged = join(temp, 'receipt.json');
  const none = '0000000000000000';
  writeFileSync(
    forged,
    JSON.stringify({
      pid: process.pid,
      namespace: process.platform === 'linux' ? readlinkSync('/proc/self/ns/net') : 'net:[0]',
      outerNamespace: 'net:[1]',
      uid: 65534,
      gid: 65534,
      capabilities: { CapInh: none, CapPrm: none, CapEff: none, CapBnd: none, CapAmb: none },
      noNewPrivs: '1',
      routes: { ipv4: [], ipv6: [] },
      listeners: [],
      fds: ['0', '1', '2'],
      node: process.version,
      pnpm: '0',
      lockfile: createHash('sha256')
        .update(readFileSync(join(root, 'pnpm-lock.yaml')))
        .digest('hex'),
      head: '0',
      fixtures: {
        ipv4: '10.250.6.1',
        ipv6: 'fd00:a6::1',
        tcpPort: 8806,
        dnsPort: 5300,
        name: 'a',
      },
      counters: join(temp, 'counters.json'),
    }),
  );
  chmodSync(forged, 0o444);
  return forged;
}

describe('A6 fails closed', () => {
  it('with no wrapper, the A6 suite refuses for want of a receipt and nothing passes', () => {
    const ran = confinedSuite({});
    expect(ran.status).not.toBe(0);
    expect(ran.said).toContain('A6 refused: no confinement receipt');
    expect(ran.passed).toBe(0);
  }, 150_000);

  it('under a broken wrapper that writes its own receipt and leaves the suite unconfined, the A6 suite refuses and nothing passes', () => {
    const forged = forgedReceipt();
    const ran = confinedSuite({ A6_RECEIPT: forged });
    expect(ran.status).not.toBe(0);
    expect(ran.said).toMatch(/A6 refused: /u);
    expect(ran.said).not.toContain('A6 refused: no confinement receipt');
    expect(ran.passed).toBe(0);
  }, 150_000);
});

describe('the A6 wrapper refuses', () => {
  it('before anything runs when unshare is missing', () => {
    const empty = join(temp, 'empty-path');
    mkdirSync(empty, { recursive: true });
    const ran = wrapper(empty);
    expect(ran.status).toBe(2);
    expect(ran.said).toContain('refused: missing unshare');
  });

  it.runIf(linuxRoot)(
    'as root on Linux, a setpriv that drops nothing',
    () => {
      const ran = wrapper(shim('setpriv'));
      expect(ran.status).toBe(2);
      expect(ran.said).toContain('refused: the privilege drop failed');
    },
    300_000,
  );

  it.runIf(linuxRoot)(
    'as root on Linux, an unshare that makes no namespace',
    () => {
      const ran = wrapper(shim('unshare'));
      expect(ran.status).not.toBe(0);
      expect(ran.said).toContain('refused: not in a network namespace of its own');
    },
    300_000,
  );
});
