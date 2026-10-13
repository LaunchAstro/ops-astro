#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Before the GPT runner's LaunchAgent is loaded on the M5 (docs/local/GPT-RUNNER.md):
# the settings and credential files are regular files of this user that no one
# else can open; the settings are the M5 site's, with the Codex version pinned;
# the runner's home and its Codex home are private and hold no instructions or
# config; Codex is the pinned version and signed in to the ChatGPT plan; custody's
# credential file holds the runner's own key, and only it, for the runner's door;
# and a runner already listening listens on loopback alone. Prints a kind, never
# a value. The checks are a Node program, so file modes read the same on macOS
# and Linux.
#
# Usage: scripts/m5/gpt-runner-install-check.sh <settings file> <credential file>

set -eu

node - "${1:?settings file}" "${2:?credential file}" <<'JS'
const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, readFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

const fault = (kind) => {
  process.stderr.write(`gpt runner install check: ${kind}\n`);
  process.exit(1);
};
const [settingsFile, credentialFile] = process.argv.slice(2);
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
const run = (args) => {
  try {
    return { ok: true, out: execFileSync(bin, args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}` };
  }
};
const reported = /\b(\d+\.\d+\.\d+)\b/u.exec(run(['--version']).out)?.[1];
if (reported !== version) fault('Codex is not the pinned version');
const login = run(['login', 'status']);
if (!login.ok || !login.out.split('\n').some((line) => line.trim() === 'Logged in using ChatGPT')) {
  fault('signed_out: Codex here is not signed in to the ChatGPT plan');
}
const door = Array.isArray(filed) ? filed.filter((entry) => entry?.destination === 'local_gpt') : [];
if (door.length !== 1 || door[0].value !== key || door[0].scheme === 'none') {
  fault('custody holds no credential, or another, for the runner’s door');
}
const port = text('OPS_LOCAL_AGENT_PORT');
if (port !== '') {
  let listening = '';
  try {
    listening = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch {
    listening = '';
  }
  const addresses = listening.split('\n').slice(1).map((line) => line.trim().split(/\s+/u)[8]).filter(Boolean);
  if (addresses.some((address) => address !== `127.0.0.1:${port}`)) fault('the runner listens beyond loopback');
}
process.stdout.write('gpt runner install check: passed\n');
JS
