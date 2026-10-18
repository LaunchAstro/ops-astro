// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: the owner's sign-in command signs in at OpenAI's own origin only,
// needs his express consent before it reads, writes or listens on anything,
// and no part of the sign-in reads Codex's own login (`~/.codex/auth.json`),
// which is a different client and must never stand in for this one.

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { browser, startSignInIssuer } from '../custody/fixtures/sign-in-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const COMMAND = join(ROOT, 'apps/model-agent/chatgpt-sign-in-command.ts');
const CODEX_MARKER = 'synthetic-codex-login-marker';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
/** A home with a planted Codex login, and an owner-only token directory inside it. */
function home(): { readonly home: string; readonly file: string } {
  const at = mkdtempSync(join(tmpdir(), 'plan-sign-in-home-'));
  dirs.push(at);
  mkdirSync(join(at, '.codex'));
  writeFileSync(
    join(at, '.codex', 'auth.json'),
    JSON.stringify({
      tokens: { access_token: CODEX_MARKER, refresh_token: CODEX_MARKER, account_id: CODEX_MARKER },
    }),
  );
  mkdirSync(join(at, '.ops-astro'));
  chmodSync(join(at, '.ops-astro'), 0o700);
  return { home: at, file: join(at, '.ops-astro', 'chatgpt-plan.json') };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => {
    server.close(() => done());
  });
  return port;
}

function command(args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [COMMAND, ...args], {
    env: { ...env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const exited = new Promise<number | null>((done) => {
    child.once('exit', done);
  });
  return { child, out: () => stdout, err: () => stderr, exited };
}

describe('the sign-in command', () => {
  it('refuses to start without the consent flag, and touches nothing', async () => {
    const { home: at, file } = home();
    const run = command(['--token-file', file], { ...process.env, HOME: at });
    expect(await run.exited).toBe(2);
    expect(run.err()).toContain('sign-in refused: SIGN_IN_CONSENT_NEEDED');
    expect(readdirSync(dirname(file))).toEqual([]);
  });

  it('refuses a relative token file path or a port out of range', async () => {
    const { home: at } = home();
    for (const args of [
      ['--token-file', 'chatgpt-plan.json'],
      ['--token-file', '/x/y.json', '--port', '0'],
    ]) {
      const run = command(['--consent-background-use', ...args], { ...process.env, HOME: at });
      // oxlint-disable-next-line no-await-in-loop -- one child at a time
      expect(await run.exited).toBe(2);
      expect(run.err()).toContain('usage:');
    }
  });

  it("asks only OpenAI's own sign-in origin, at the port given, with nothing from Codex's login", async () => {
    const { home: at, file } = home();
    const port = await freePort();
    const run = command(
      ['--consent-background-use', '--token-file', file, '--port', String(port)],
      {
        ...process.env,
        HOME: at,
        CODEX_HOME: join(at, '.codex'),
      },
    );
    try {
      const until = Date.now() + 20_000;
      while (!run.out().includes('\nhttps://') && Date.now() < until)
        // oxlint-disable-next-line no-await-in-loop -- waits for the printed address
        await new Promise((done) => {
          setTimeout(done, 50);
        });
      const address = new URL(run.out().split('\n')[1] ?? '');
      expect(address.origin).toBe('https://auth.openai.com');
      expect(address.pathname).toBe('/api/accounts/authorize');
      expect(address.searchParams.get('redirect_uri')).toBe(
        `http://127.0.0.1:${port}/auth/callback`,
      );
      expect(run.out()).not.toContain(CODEX_MARKER);
      expect(readdirSync(dirname(file)).toSorted()).toEqual([
        'chatgpt-host.json',
        'chatgpt-plan.json.lock',
      ]);
    } finally {
      run.child.kill('SIGTERM');
      await run.exited;
    }
    expect(run.err()).toBe('');
  });
});

describe("Codex's own login", () => {
  it('no sign-in source names it or imports the local agent that uses it', () => {
    const sources = [
      'apps/model-agent/chatgpt-sign-in-command.ts',
      'apps/model-agent/chatgpt-sign-in.ts',
      'apps/model-agent/id-token.ts',
      'packages/core-custody/src/plan-sign-in.ts',
    ];
    for (const source of sources) {
      const text = readFileSync(join(ROOT, source), 'utf8');
      const code = text.replaceAll(/^\s*\/\/.*$/gmu, '');
      expect(code, source).not.toMatch(
        /\.codex|auth\.json|CODEX_HOME|homedir|node:os|local-agent/u,
      );
    }
  });

  it('a whole sign-in with a planted Codex login in HOME and CODEX_HOME sends and stores none of it', async () => {
    const { home: at, file } = home();
    const saved = { HOME: process.env['HOME'], CODEX_HOME: process.env['CODEX_HOME'] };
    process.env['HOME'] = at;
    process.env['CODEX_HOME'] = join(at, '.codex');
    const issuer = await startSignInIssuer();
    try {
      const b = browser(issuer);
      expect(
        await signIn({
          issuer: issuer.origin,
          tokenFile: file,
          port: 0,
          timeoutMs: 10_000,
          say: b.say,
        }),
      ).toEqual({
        ok: true,
      });
      expect(issuer.forms.map(String).join('\n')).not.toContain(CODEX_MARKER);
      expect(b.lines.join('\n')).not.toContain(CODEX_MARKER);
      for (const name of readdirSync(dirname(file)))
        expect(readFileSync(join(dirname(file), name)).toString('latin1')).not.toContain(
          CODEX_MARKER,
        );
    } finally {
      await issuer.close();
      process.env['HOME'] = saved.HOME;
      if (saved.CODEX_HOME === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = saved.CODEX_HOME;
    }
  });
});
