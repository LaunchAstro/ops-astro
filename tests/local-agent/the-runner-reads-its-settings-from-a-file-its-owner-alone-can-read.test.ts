// SPDX-License-Identifier: AGPL-3.0-only
//
// On the M5 the runner is a LaunchAgent, and a LaunchAgent's environment is
// written in its plist, which others on the machine can read. So the runner
// takes its settings, its key among them, from the file OPS_LOCAL_AGENT_SETTINGS
// names: a JSON object of its own settings, readable by its owner alone. A file
// others can read, a link in its place, a setting it does not know, a value that
// is not text, or a setting also given in the environment is refused, naming
// the file's setting and never a value. The runner process itself is started
// here, as the LaunchAgent starts it.

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withSettingsFile } from '../../apps/local-agent/settings-file.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

const MAIN = resolve(import.meta.dirname, '../../apps/local-agent/main.ts');

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

/** A laptop whose runner key is in a settings file, not in the environment. */
function setUp(
  contents: unknown,
  mode = 0o600,
): { env: Record<string, string | undefined>; file: string } {
  const w = makeWorld();
  world = w;
  const dir = join(w.userHome, 'settings');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'gpt-runner.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  chmodSync(file, mode);
  const { OPS_LOCAL_AGENT_KEY: _key, ...env } = w.env;
  return { env: { ...env, OPS_LOCAL_AGENT_SETTINGS: file }, file };
}

/** The runner process on `env`: what it printed until it said where it listens, or until it ended. */
async function runProcess(env: Record<string, string | undefined>): Promise<string> {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  return await new Promise((done) => {
    const finish = (): void => {
      child.kill('SIGTERM');
      done(printed);
    };
    const timer = setTimeout(finish, 8_000);
    const onData = (chunk: Buffer): void => {
      printed += chunk.toString('utf8');
      if (printed.includes('local-gpt runner on')) {
        clearTimeout(timer);
        finish();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => {
      clearTimeout(timer);
      done(printed);
    });
  });
}

const problemOf = (env: Record<string, string | undefined>): string => {
  const loaded = withSettingsFile(env);
  return loaded.ok ? '' : loaded.message;
};

describe('the runner process', () => {
  it('starts with the key its settings file holds, printing no value', async () => {
    const { env } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY });
    const printed = await runProcess(env);
    expect(printed).toContain('local-gpt runner on http://127.0.0.1:');
    expect(printed).not.toContain(RUNNER_KEY);
  });

  it('refuses a settings file others can read, naming the setting and never the key', async () => {
    const { env } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY }, 0o644);
    const printed = await runProcess(env);
    expect(printed).toContain('SETTINGS_REFUSED: OPS_LOCAL_AGENT_SETTINGS');
    expect(printed).not.toContain('local-gpt runner on');
    expect(printed).not.toContain(RUNNER_KEY);
  });
});

// eslint-disable-next-line max-lines-per-function -- one case per way the file is refused
describe("the runner's settings file", () => {
  it.each([
    ['readable by others', { OPS_LOCAL_AGENT_KEY: RUNNER_KEY }, 0o644],
    [
      'holding a setting it does not know',
      { OPS_LOCAL_AGENT_KEY: RUNNER_KEY, OPENAI_API_KEY: 'x' },
      0o600,
    ],
    [
      'holding a value that is not text',
      { OPS_LOCAL_AGENT_KEY: RUNNER_KEY, OPS_LOCAL_AGENT_PORT: 8123 },
      0o600,
    ],
    ['that is not a JSON object', `["${RUNNER_KEY}"]`, 0o600],
    ['that is not JSON at all', `OPS_LOCAL_AGENT_KEY=${RUNNER_KEY}`, 0o600],
  ])('is refused %s, naming the setting and never the key', (_label, contents, mode) => {
    const { env } = setUp(contents, mode);
    const problem = problemOf(env);
    expect(problem).toContain('OPS_LOCAL_AGENT_SETTINGS');
    expect(problem).not.toContain(RUNNER_KEY);
  });

  it('is refused when a link stands in its place', () => {
    const { env, file } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY });
    const link = join(file, '..', 'linked.json');
    symlinkSync(file, link);
    expect(problemOf({ ...env, OPS_LOCAL_AGENT_SETTINGS: link })).toContain(
      'OPS_LOCAL_AGENT_SETTINGS',
    );
  });

  it('is refused when it is not there', () => {
    const { env, file } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY });
    expect(problemOf({ ...env, OPS_LOCAL_AGENT_SETTINGS: `${file}.gone` })).toContain(
      'OPS_LOCAL_AGENT_SETTINGS',
    );
  });

  it('is refused when a setting it holds is also given in the environment', () => {
    const { env } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY });
    const problem = problemOf({ ...env, OPS_LOCAL_AGENT_KEY: `${RUNNER_KEY}-other` });
    expect(problem).toContain('OPS_LOCAL_AGENT_KEY');
    expect(problem).not.toContain(RUNNER_KEY);
  });

  it('adds what it holds to the environment, and nothing else', () => {
    const { env } = setUp({ OPS_LOCAL_AGENT_KEY: RUNNER_KEY });
    const loaded = withSettingsFile(env);
    expect(loaded.ok && loaded.env['OPS_LOCAL_AGENT_KEY']).toBe(RUNNER_KEY);
    expect(loaded.ok && Object.keys(loaded.env).toSorted()).toEqual(
      [...Object.keys(env), 'OPS_LOCAL_AGENT_KEY'].toSorted(),
    );
  });
});
