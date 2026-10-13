// SPDX-License-Identifier: AGPL-3.0-only
//
// The GPT runner's install check certifies the runner the plist will start
// (docs/local/GPT-RUNNER.md): its settings as the runner's own loader reads
// them, the Codex binary those settings name, every folder Codex reads
// instructions from, a credential file read through the one descriptor it
// judged, and a port the runner can bind on loopback. A state that only looks
// right fails the check, which prints a kind, never a value.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FAKE_CODEX, makeWorld, RUNNER_KEY, type World } from './world.ts';

const CHECK = resolve(import.meta.dirname, '../../scripts/m5/gpt-runner-install-check.sh');
const DOOR = [
  {
    ref: 'local_runner',
    kind: 'api_key',
    account: 'synthetic-plan',
    destination: 'local_gpt',
    header: 'authorization',
    value: RUNNER_KEY,
  },
];

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

interface Files {
  readonly w: World;
  readonly settingsFile: string;
  readonly credentialFile: string;
}

function installation(settings: Record<string, unknown> = {}): Files {
  const w = makeWorld();
  world = w;
  chmodSync(w.agentHome, 0o700);
  chmodSync(w.codexHome, 0o700);
  const settingsFile = join(w.agentHome, 'settings.json');
  const credentialFile = join(w.agentHome, 'credentials.json');
  const written = {
    OPS_LOCAL_AGENT_SITE: 'm5',
    OPS_LOCAL_AGENT_CODEX_VERSION: '0.162.1',
    OPS_LOCAL_AGENT_HOME: w.agentHome,
    OPS_LOCAL_AGENT_CODEX_BIN: FAKE_CODEX,
    OPS_LOCAL_AGENT_KEY: RUNNER_KEY,
    ...settings,
  };
  for (const [name, value] of Object.entries(written)) {
    if (value === undefined) delete (written as Record<string, unknown>)[name];
  }
  writeFileSync(settingsFile, JSON.stringify(written), { mode: 0o600 });
  writeFileSync(credentialFile, JSON.stringify(DOOR), { mode: 0o600 });
  return { w, settingsFile, credentialFile };
}

function checked(files: Files, path = process.env['PATH']) {
  return spawnSync('/bin/sh', [CHECK, files.settingsFile, files.credentialFile], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: path ?? '/usr/bin:/bin' },
  });
}

/** A folder for PATH holding node and the named programs, each a script or a link. */
function binWith(files: Files, programs: Record<string, string>): string {
  const bin = join(dirname(files.w.agentHome), 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const [name, body] of Object.entries(programs)) {
    if (body.startsWith('/')) symlinkSync(body, join(bin, name));
    else writeFileSync(join(bin, name), body, { mode: 0o700 });
  }
  return bin;
}

/** A Codex stand-in at an absolute path, named in the settings. */
function codexAs(files: Files, body: string): void {
  const bin = join(dirname(files.w.agentHome), 'codex-as.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  const settings = JSON.parse(readFileSync(files.settingsFile, 'utf8')) as Record<string, string>;
  writeFileSync(
    files.settingsFile,
    JSON.stringify({ ...settings, OPS_LOCAL_AGENT_CODEX_BIN: bin }),
  );
}

function refused(result: ReturnType<typeof checked>): void {
  expect(result.error).toBeUndefined();
  expect(result.stdout).not.toContain('passed');
  expect(result.stderr).toContain('gpt runner install check:');
  expect(`${result.stdout}${result.stderr}`).not.toContain(RUNNER_KEY);
  expect(result.status).not.toBe(0);
}

it('refuses settings that name no Codex binary, so the runner would take any codex on its own PATH', () => {
  const files = installation({ OPS_LOCAL_AGENT_CODEX_BIN: undefined });
  refused(checked(files, binWith(files, { codex: FAKE_CODEX })));
});

it.each([
  ['a setting the runner does not take', { OPS_LOCAL_AGENT_EXTRA: 'x' }],
  ['a port that is not text', { OPS_LOCAL_AGENT_PORT: 1 }],
  [
    'a token cap above the default with no approval kept',
    { OPS_LOCAL_AGENT_CAP_TOKENS: '3000000' },
  ],
])('refuses %s, as the runner refuses it at start', (_label, settings) => {
  refused(checked(installation(settings)));
});

it('refuses a pre-release of the pinned version', () => {
  const files = installation();
  files.w.knobs({ version: '0.162.1-alpha.3' });
  refused(checked(files));
});

it('refuses a Codex whose version answer fails', () => {
  const files = installation();
  codexAs(
    files,
    `if (process.argv[2] === '--version') { process.stderr.write('codex-cli 0.162.1\\n'); process.exit(127); }
if (process.argv[2] === 'login') process.stderr.write('Logged in using ChatGPT\\n');`,
  );
  refused(checked(files));
});

it.each([
  ['the runner home', (w: World) => w.agentHome],
  ['the child’s working folder', (w: World) => join(w.agentHome, 'cwd')],
])('refuses instructions in %s, which Codex reads too', (_label, folder) => {
  const files = installation();
  mkdirSync(folder(files.w), { recursive: true, mode: 0o700 });
  writeFileSync(join(folder(files.w), 'AGENTS.md'), 'planted');
  refused(checked(files));
});

it('refuses a dangling link named config.toml in the Codex home', () => {
  const files = installation();
  symlinkSync(join(dirname(files.w.agentHome), 'later'), join(files.w.codexHome, 'config.toml'));
  refused(checked(files));
});

it('refuses a config Codex writes into its home while the check runs', () => {
  const files = installation();
  codexAs(
    files,
    `import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') process.stdout.write('codex-cli 0.162.1\\n');
if (process.argv[2] === 'login') {
  writeFileSync(process.env.CODEX_HOME + '/config.toml', 'planted');
  process.stderr.write('Logged in using ChatGPT\\n');
}`,
  );
  refused(checked(files));
});

it('refuses a runner home named through a link with a trailing slash', () => {
  const files = installation();
  const link = join(dirname(files.w.agentHome), 'link');
  symlinkSync(files.w.agentHome, link);
  const settings = JSON.parse(readFileSync(files.settingsFile, 'utf8')) as Record<string, string>;
  writeFileSync(
    files.settingsFile,
    JSON.stringify({ ...settings, OPS_LOCAL_AGENT_HOME: `${link}/` }),
  );
  refused(checked(files));
});

it('refuses a runner home inside a git checkout, whose AGENTS.md Codex reads', () => {
  const files = installation();
  const root = dirname(files.w.agentHome);
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'AGENTS.md'), 'planted');
  refused(checked(files));
});

it('refuses a credential file that is a pipe, not a regular file', async () => {
  const files = installation();
  rmSync(files.credentialFile);
  spawnSync('mkfifo', ['-m', '600', files.credentialFile]);
  const writer = spawn(
    '/bin/sh',
    ['-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(DOOR), files.credentialFile],
    {
      stdio: 'ignore',
    },
  );
  try {
    refused(checked(files));
  } finally {
    writer.kill();
    await new Promise((done) => setTimeout(done, 50));
  }
});

it('refuses a port held by a listener lsof cannot see', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP listener');
  try {
    const files = installation({ OPS_LOCAL_AGENT_PORT: String(address.port) });
    // lsof without root reads nothing of another user's listener: no output, exit 1.
    refused(checked(files, binWith(files, { lsof: '#!/bin/sh\nexit 1\n' })));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('refuses a Codex binary it cannot start without printing the path', () => {
  const files = installation({ OPS_LOCAL_AGENT_CODEX_BIN: '/opt/private-path\u0000x' });
  const result = checked(files);
  refused(result);
  expect(`${result.stdout}${result.stderr}`).not.toContain('private-path');
});
