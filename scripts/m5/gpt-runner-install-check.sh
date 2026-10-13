#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Before the GPT runner's LaunchAgent is loaded on the M5 (docs/local/GPT-RUNNER.md):
# the settings and credential files are regular files of this user that no one
# else can open; the settings are the M5 site's, with the Codex version pinned;
# the runner's home and its Codex home are private and hold no instructions or
# config; Codex is the pinned version and signed in to the ChatGPT plan; custody's
# credential file is one custody itself loads (its own parser, no second one)
# and holds the runner's own key, and only it, for the runner's door, presented
# as the door takes it (the authorization header, bearer); and a runner already
# listening listens on loopback alone, read by an lsof that completed. Prints a
# kind, never a value. The checks are a Node program, so file modes read the
# same on macOS and Linux.
#
# Usage: scripts/m5/gpt-runner-install-check.sh <settings file> <credential file>

set -eu

root=$(cd "${0%/*}/../.." && pwd)
node --input-type=module - "$root" "${1:?settings file}" "${2:?credential file}" <<'JS'
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fault = (kind) => {
  process.stderr.write(`gpt runner install check: ${kind}\n`);
  process.exit(1);
};
const [root, settingsFile, credentialFile] = process.argv.slice(2);
const custody = await import(pathToFileURL(join(root, 'packages/core-custody/src/credentials.ts')).href);
const own = (path, mode) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  return !stat.isSymbolicLink() && (stat.mode & 0o777) === mode && stat.uid === process.getuid();
};
if (!own(settingsFile, 0o600) || !own(credentialFile, 0o600)) {
  fault('a file is missing, a link, not this user’s, or open to others (chmod 600)');
}
let settings;
let filed;
try {
  settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  filed = JSON.parse(readFileSync(credentialFile, 'utf8'));
} catch {
  fault('a file is not JSON');
}
const text = (name) => (typeof settings?.[name] === 'string' ? settings[name] : '');
if (text('OPS_LOCAL_AGENT_SITE') !== 'm5') fault('the settings are not the M5 site’s');
const version = text('OPS_LOCAL_AGENT_CODEX_VERSION');
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(version)) fault('no Codex version is pinned');
const home = text('OPS_LOCAL_AGENT_HOME');
const key = text('OPS_LOCAL_AGENT_KEY');
if (!isAbsolute(home)) fault('the runner home is not an absolute path');
if (key.length < 32) fault('the runner key is missing or short');
const codexHome = join(home, 'codex');
for (const dir of [home, codexHome]) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    fault('the runner home or its Codex home is missing');
  }
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fault('the runner home or its Codex home is open to others (chmod 700)');
}
for (const name of ['AGENTS.md', 'AGENTS.override.md', 'config.toml']) {
  if (existsSync(join(codexHome, name))) fault('the Codex home holds instructions or a config');
}
const bin = text('OPS_LOCAL_AGENT_CODEX_BIN') || 'codex';
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: codexHome };
// Both streams are read: Codex 0.162.1 writes its login status to stderr.
const run = (args) => {
  const ran = spawnSync(bin, args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
};
const reported = /\b(\d+\.\d+\.\d+)\b/u.exec(run(['--version']).out)?.[1];
if (reported !== version) fault('Codex is not the pinned version');
const login = run(['login', 'status']);
if (!login.ok || !login.out.split('\n').some((line) => line.trim() === 'Logged in using ChatGPT')) {
  fault('signed_out: Codex here is not signed in to the ChatGPT plan');
}
// Custody's own parser: a file it refuses at load is refused here, by the same rules.
const loaded = custody.parseCredentials(filed);
if (!loaded.ok) fault(`custody refuses the credential file (${loaded.code})`);
const door = [...loaded.credentials.values()].filter((entry) => entry.destination === 'local_gpt');
// The runner's door takes only `Authorization: Bearer <key>` (door.ts): another header or scheme is answered 401.
if (door.length !== 1 || door[0].header !== 'authorization' || custody.presented(door[0]) !== `Bearer ${key}`) {
  fault('custody holds no credential, or another, for the runner’s door');
}
const port = text('OPS_LOCAL_AGENT_PORT');
if (port !== '') {
  // -b skips calls that can block on a mount and -w drops warnings, so any
  // stderr is a failure. Only exit 1 with no output at all means no listener.
  const read = spawnSync('lsof', ['-b', '-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const out = read.stdout ?? '';
  const addresses = out.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  const none = read.status === 1 && out === '' && read.stderr === '';
  const listed = read.status === 0 && read.stderr === '' && addresses.length > 0;
  if (read.error !== undefined || !(none || listed)) {
    fault('the listeners on the runner’s port could not be read (is lsof installed?)');
  }
  if (addresses.some((address) => address !== `127.0.0.1:${port}`)) fault('the runner listens beyond loopback');
}
process.stdout.write('gpt runner install check: passed\n');
JS
