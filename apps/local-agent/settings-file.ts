// SPDX-License-Identifier: AGPL-3.0-only
//
// The runner's settings from a file (docs/local/GPT-RUNNER.md). On the M5 the
// runner is a LaunchAgent, and a LaunchAgent's environment is written in its
// plist, which others on the machine can read; so its settings, its key among
// them, come from the file OPS_LOCAL_AGENT_SETTINGS names. The file is a JSON
// object of the runner's own settings, each a string, read once at start. It is
// opened without following a link, and judged on what was opened: a regular
// file of the runner's own user that no one else can read or write. A setting
// it does not know, a value that is not text, or a setting also given in the
// environment is refused. A refusal names a setting, never a value.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export const SETTINGS_FILE = 'OPS_LOCAL_AGENT_SETTINGS';

/** The settings the file may hold: the runner's own, and nothing a child or the API reads. */
const FILE_SETTINGS: ReadonlySet<string> = new Set([
  'OPS_LOCAL_AGENT_KEY',
  'OPS_LOCAL_AGENT_HOME',
  'OPS_LOCAL_AGENT_PORT',
  'OPS_LOCAL_AGENT_SITE',
  'OPS_LOCAL_AGENT_CODEX_VERSION',
  'OPS_LOCAL_AGENT_CODEX_BIN',
  'OPS_LOCAL_AGENT_CAP_TOKENS',
]);

type Environment = Readonly<Record<string, string | undefined>>;

export type FileSettings =
  | { readonly ok: true; readonly env: Environment }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): FileSettings => ({ ok: false, message });

/** The file's text, read through one descriptor, or why it was refused. */
function readOwn(file: string): string | { readonly refused: string } {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { refused: `${SETTINGS_FILE} names no file this runner can open (missing, or a link)` };
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return { refused: `${SETTINGS_FILE} names something that is not a file` };
    if ((opened.mode & 0o077) !== 0)
      return { refused: `${SETTINGS_FILE} is open to others: chmod 600 it` };
    if (opened.uid !== process.getuid?.())
      return { refused: `${SETTINGS_FILE} is not this user's file` };
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** The environment with the settings file's settings added, or why the file was refused. */
export function withSettingsFile(env: Environment): FileSettings {
  const file = env[SETTINGS_FILE] ?? '';
  if (file === '') return { ok: true, env };
  const text = readOwn(file);
  if (typeof text !== 'string') return refuse(text.refused);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(`${SETTINGS_FILE} is not a JSON object of settings`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse(`${SETTINGS_FILE} is not a JSON object of settings`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const added: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!FILE_SETTINGS.has(name))
      return refuse(`${SETTINGS_FILE} holds a setting the runner does not take`);
    if (typeof value !== 'string')
      return refuse(`${SETTINGS_FILE} holds ${name} as something other than text`);
    if ((env[name] ?? '') !== '')
      return refuse(`${name} is set both in the environment and in ${SETTINGS_FILE}`);
    added[name] = value;
  }
  return { ok: true, env: { ...env, ...added } };
}
