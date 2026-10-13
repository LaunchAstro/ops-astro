#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
#
# Before the GPT runner's LaunchAgent is loaded on the M5 (docs/local/GPT-RUNNER.md),
# it certifies the runner the plist will start. The settings are read by the
# runner's own loader (settings-file.ts, settings.ts), from the file alone: the
# M5 site's, with the Codex version pinned, and naming the runner home and the
# Codex binary by plain absolute paths. The runner home, its Codex home and the
# child's working folder hold no instructions or config, before Codex runs and
# after, and no git checkout holds the home. That binary is the pinned version
# and signed in to the ChatGPT plan. Custody's credential file is a regular 0600
# file of this user, read through the descriptor that was judged, that custody's
# own parser loads, holding the runner's own key, and only it, for the runner's
# door, presented as the door takes it (the authorization header, bearer). No
# access list lets others into either file or either home. The settings fix the
# runner's port, and a runner already listening there listens on loopback
# alone, read by an lsof that completed; when lsof sees none, the runner's own
# bind is tried. Prints a kind, never a value.
#
# Usage: scripts/m5/gpt-runner-install-check.sh <settings file> <credential file>

set -eu

root=$(cd "${0%/*}/../.." && pwd)
node --input-type=module - "$root" "${1:?settings file}" "${2:?credential file}" <<'JS'
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fault = (kind) => {
  process.stderr.write(`gpt runner install check: ${kind}\n`);
  process.exit(1);
};
const [root, settingsFile, credentialFile] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(root, path)).href);
const custody = await load('packages/core-custody/src/credentials.ts');
const { withSettingsFile } = await load('apps/local-agent/settings-file.ts');
const { readSettings } = await load('apps/local-agent/settings.ts');

// The runner's own loader, given the file alone: a setting the plist or launchd
// would add is one the runner then refuses as set twice, or one checked here as missing.
const loaded = withSettingsFile({ OPS_LOCAL_AGENT_SETTINGS: settingsFile });
if (!loaded.ok) fault(`the runner refuses its settings file: ${loaded.message}`);
const env = loaded.env;
if (env.OPS_LOCAL_AGENT_SITE !== 'm5') fault('the settings are not the M5 site’s');
const read = readSettings(env);
if (!read.ok) fault(`the runner refuses these settings: ${read.code}`);
const { key, home, codexHome, codexBin, codexVersion } = read.settings;
if (env.OPS_LOCAL_AGENT_HOME !== home || resolve(home) !== home) {
  fault('the settings name no plain absolute runner home');
}
if (!isAbsolute(codexBin)) fault('the settings name no absolute Codex binary');

const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
for (const dir of [home, codexHome]) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    fault('the runner home or its Codex home is missing');
  }
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fault('the runner home or its Codex home is open to others (chmod 700)');
}
// Mode bits miss an access list: macOS lists its entries under `ls -le`, and
// one that allows anything lets someone else in; Linux marks any list with `+`.
for (const path of [settingsFile, credentialFile, home, codexHome]) {
  const darwin = process.platform === 'darwin';
  const listed = spawnSync('/bin/ls', [darwin ? '-lde' : '-ld', path], { encoding: 'utf8' });
  if (listed.status !== 0) fault('the access lists of the runner’s files could not be read');
  const [first = '', ...entries] = listed.stdout.split('\n').filter((line) => line !== '');
  const opened = darwin ? entries.some((entry) => / allow /u.test(entry)) : first.split(/\s/u)[0].endsWith('+');
  if (opened) fault('an access list lets others into a runner file or home');
}
// Both the path as named and the real one: a linked ancestor can hide the checkout git finds.
for (const named of [home, realpathSync(home)]) {
  for (let dir = named; dir !== dirname(dir); dir = dirname(dir)) {
    if (present(join(dir, '.git'))) fault('the runner home is inside a git checkout');
  }
}
// Codex reads instructions from its home and its working folder; a dangling link counts.
const planted = () => {
  for (const dir of [home, codexHome, join(home, 'cwd')]) {
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'config.toml']) {
      if (present(join(dir, name))) fault('a runner folder holds instructions or a config');
    }
  }
};
planted();
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: codexHome };
// Both streams are read: Codex 0.162.1 writes its login status to stderr.
const run = (args) => {
  let ran;
  try {
    ran = spawnSync(codexBin, args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  } catch {
    fault('the Codex binary cannot be started');
  }
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}` };
};
const version = run(['--version']);
if (!version.ok || /^codex-cli (\S+)$/mu.exec(version.out)?.[1] !== codexVersion) fault('Codex is not the pinned version');
const login = run(['login', 'status']);
if (!login.ok || !login.out.split('\n').some((line) => line.trim() === 'Logged in using ChatGPT')) {
  fault('signed_out: Codex here is not signed in to the ChatGPT plan');
}
planted();

// Opened once, without following a link or waiting on a pipe, and judged and read through that descriptor.
let credentialText;
try {
  const descriptor = openSync(credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid()) {
      credentialText = readFileSync(descriptor, 'utf8');
    }
  } finally {
    closeSync(descriptor);
  }
} catch {
  credentialText = undefined;
}
if (credentialText === undefined) fault('the credential file is missing, a link, not a file, not this user’s, or not 0600');
let filed;
try {
  filed = JSON.parse(credentialText);
} catch {
  fault('the credential file is not JSON');
}
// Custody's own parser: a file it refuses at load is refused here, by the same rules.
const credentials = custody.parseCredentials(filed);
if (!credentials.ok) fault(`custody refuses the credential file (${credentials.code})`);
const door = [...credentials.credentials.values()].filter((entry) => entry.destination === 'local_gpt');
// The runner's door takes only `Authorization: Bearer <key>` (door.ts): another header or scheme is answered 401.
if (door.length !== 1 || door[0].header !== 'authorization' || custody.presented(door[0]) !== `Bearer ${key}`) {
  fault('custody holds no credential, or another, for the runner’s door');
}

// Custody's destination names the port, so the runner must not leave it to the system.
const port = env.OPS_LOCAL_AGENT_PORT ?? '';
if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > 65_535) fault('the settings fix no port for the runner (1 to 65535)');
// -b skips calls that can block on a mount and -w drops warnings, so any
// stderr is a failure. Only exit 1 with no output at all means no listener.
const listed = spawnSync('lsof', ['-b', '-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10_000,
});
const out = listed.stdout ?? '';
const addresses = out.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
const none = listed.status === 1 && out === '' && listed.stderr === '';
const some = listed.status === 0 && listed.stderr === '' && addresses.length > 0;
if (listed.error !== undefined || !(none || some)) {
  fault('the listeners on the runner’s port could not be read (is lsof installed?)');
}
if (addresses.some((address) => address !== `127.0.0.1:${port}`)) fault('the runner listens beyond loopback');
// lsof without root sees no other user's listener, so the runner's own bind has the last word.
if (none) {
  const bound = await new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(Number(port), '127.0.0.1', () => probe.close(() => done(true)));
  });
  if (!bound) fault('something lsof cannot see holds the runner’s port');
}
process.stdout.write('gpt runner install check: passed\n');
JS
