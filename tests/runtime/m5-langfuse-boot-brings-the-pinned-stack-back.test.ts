// SPDX-License-Identifier: AGPL-3.0-only
//
// The M5's Langfuse boot script (scripts/m5/langfuse-up.sh), run as launchd
// runs it at login, with stand-ins for docker, open and sleep on PATH. It
// waits for Docker, then starts the existing Compose project with the
// repository's pins as the last file. It never stops, removes or pulls on its
// own, and a missing installation file is refused before Docker is touched.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/m5/langfuse-up.sh');
const PINS = join(ROOT, 'deploy/m5/langfuse-pins.override.yml');
const INSTALLED = ['docker-compose.yml', 'docker-compose.override.yml', '.env'];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Boot {
  /** How many `docker info` calls fail before Docker answers; Infinity never answers. */
  readonly dockerLate?: number;
  readonly composeFails?: boolean;
  readonly missing?: string;
}

interface Booted {
  readonly code: number;
  readonly output: string;
  /** Each docker call: its working folder, then its arguments. */
  readonly docker: string[];
  readonly opened: boolean;
  readonly install: string;
}

/** Writes an executable stand-in. */
function tool(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function boot({ dockerLate = 0, composeFails = false, missing }: Boot = {}): Booted {
  const world = mkdtempSync(join(tmpdir(), 'm5-langfuse-up-'));
  folders.push(world);
  const install = join(world, 'langfuse');
  const bin = join(world, 'bin');
  mkdirSync(install);
  mkdirSync(bin);
  for (const name of INSTALLED)
    if (name !== missing) writeFileSync(join(install, name), 'installed\n');
  const log = join(world, 'docker.log');
  const count = join(world, 'info.count');
  writeFileSync(log, '');
  writeFileSync(count, '0');
  const late = Number.isFinite(dockerLate) ? String(dockerLate) : '999999';
  tool(
    bin,
    'docker',
    [
      `echo "$(pwd) $*" >> '${log}'`,
      'if [ "$1" = info ]; then',
      `  n=$(cat '${count}'); echo $((n + 1)) > '${count}'`,
      `  [ "$n" -ge ${late} ] && exit 0 || exit 1`,
      'fi',
      composeFails ? 'exit 1' : 'exit 0',
    ].join('\n'),
  );
  tool(bin, 'open', `touch '${join(world, 'opened')}'`);
  tool(bin, 'sleep', 'exit 0');
  let code = 0;
  let output: string;
  try {
    output = execFileSync('sh', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LANGFUSE_INSTALL_DIR: install,
        LANGFUSE_REPO_DIR: ROOT,
        LANGFUSE_DOCKER_WAIT_SECONDS: '30',
      },
    });
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    code = failed.status;
    output = `${failed.stdout}${failed.stderr}`;
  }
  const docker = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { code, output, docker, opened: existsSync(join(world, 'opened')), install };
}

const UP = (install: string): string =>
  `${install} compose --project-name langfuse -f docker-compose.yml -f docker-compose.override.yml -f ${PINS} up --detach --no-build --pull missing`;

describe('the M5 Langfuse boot script', () => {
  it('starts the existing project with the pins last once Docker answers', () => {
    const { code, output, docker, opened, install } = boot();
    expect(code).toBe(0);
    expect(output).toContain('langfuse up: started at the pinned images');
    expect(docker.filter((call) => call.includes(' compose '))).toEqual([UP(install)]);
    expect(opened).toBe(false);
  });

  it('opens Docker once and waits for it after a cold boot', () => {
    const { code, docker, opened, install } = boot({ dockerLate: 3 });
    expect(code).toBe(0);
    expect(opened).toBe(true);
    expect(docker.filter((call) => call.endsWith(' info'))).toHaveLength(4);
    expect(docker.at(-1)).toBe(UP(install));
  });

  it('gives up with a reason when Docker never answers, starting nothing', () => {
    const { code, output, docker } = boot({ dockerLate: Infinity });
    expect(code).toBe(1);
    expect(output).toContain('langfuse up: refused, Docker did not start within 30s');
    expect(docker.filter((call) => call.includes(' compose '))).toEqual([]);
  });

  it.each(INSTALLED)('refuses an installation without %s before touching Docker', (name) => {
    const { code, output, docker } = boot({ missing: name });
    expect(code).toBe(1);
    expect(output).toContain(`langfuse up: refused, missing ${name}`);
    expect(docker).toEqual([]);
  });

  it('reports a failed start instead of claiming the stack is up', () => {
    const { code, output, docker, install } = boot({ composeFails: true });
    expect(docker.at(-1)).toBe(UP(install));
    expect(code).not.toBe(0);
    expect(output).not.toContain('started');
  });
});

it('the M5 Langfuse boot script never stops, removes, recreates or pulls by itself', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  for (const word of [' down', ' rm ', ' stop', ' kill', ' pull ', '--volumes', '--force-recreate'])
    expect(script.replaceAll(/^#.*$/gmu, ''), word).not.toContain(word);
});
