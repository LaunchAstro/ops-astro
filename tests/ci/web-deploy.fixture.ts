// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the S0-6 web deploy and maintenance page cases: a stored build
// output, the settings a person's deploy runs with (canaries included), and a
// `vercel` on PATH that logs its arguments, working folder and environment and
// answers as told, and the sign-in server's `/health` as a loopback stand-in:
// no real deploy, no network.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';

export const STAGED = '0123456789ab';
export const CANARY = 'canary-5d19e0-web-deploy-secret';
export const URL_MADE = 'https://ops-astro-staging-a1b2c3d4e.vercel.app';
export const ORG = 'team_madeUpOrg0123';
export const PROJECT = 'prj_madeUpProject0123';
export const AUTH_VERSION = 'v2.180.0';

// Made by the file's first hook, so a file whose tests all skip leaves no folder (temp guard).
export const scratch: string = join(tmpdir(), `s0-6-web-${randomBytes(6).toString('hex')}`);
beforeAll(() => mkdirSync(scratch, { mode: 0o700 }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The sign-in server's health answer, as Supabase's Auth gives it. */
const auth = createServer((request, response) => {
  const health = request.url === '/auth/v1/health';
  response.writeHead(health ? 200 : 404, { 'content-type': 'application/json' });
  response.end(health ? JSON.stringify({ version: AUTH_VERSION, name: 'GoTrue' }) : '{}');
});
let authUrl = '';
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      auth.listen(0, '127.0.0.1', () => {
        const address = auth.address();
        authUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/auth/v1`;
        resolve();
      });
    }),
);
afterAll(
  () =>
    new Promise<void>((resolve) => {
      auth.close(() => resolve());
    }),
);

let made = 0;
export const folder = (name: string): string => {
  made += 1;
  const path = join(scratch, `${name}-${String(made)}`);
  mkdirSync(path, { recursive: true });
  return path;
};

export type Files = Record<string, string | object>;
export const SYDNEY: Readonly<Record<string, unknown>> = {
  runtime: 'nodejs24.x',
  handler: 'index.mjs',
  regions: ['syd1'],
};
export const OUTPUT: Files = {
  'config.json': { version: 3, routes: [{ handle: 'filesystem' }] },
  'static/index.html': '<!doctype html><title>Ops Astro</title>',
  'functions/api.func/.vc-config.json': SYDNEY,
  'functions/api.func/index.mjs': 'export {};',
};

/** An artefact store holding one release output for `version`, stamped and digested. */
export function store(files: Files = OUTPUT, version: string = STAGED): string {
  const root = folder('store');
  const out = join(root, artefactName(version));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  stampOutput(out, version);
  return root;
}

interface Answers {
  deploy?: { out: string; status: number };
  inspect?: { out: string; status: number };
}

/** A `vercel` on PATH that logs each call and answers as told. */
export interface FakeVercel {
  readonly path: string;
  readonly log: string;
  readonly lines: (kind: string) => string[];
}

export function fakeVercel(answers: Answers = {}): FakeVercel {
  const bin = folder('bin');
  const log = join(bin, 'calls.log');
  const deploy = answers.deploy ?? { out: URL_MADE, status: 0 };
  const inspect = answers.inspect ?? {
    out: JSON.stringify({ url: URL_MADE.slice('https://'.length), regions: ['syd1'] }),
    status: 0,
  };
  writeFileSync(join(bin, 'deploy.out'), `${deploy.out}\n`);
  writeFileSync(join(bin, 'inspect.out'), `${inspect.out}\n`);
  writeFileSync(
    join(bin, 'vercel'),
    [
      '#!/bin/sh',
      `log='${log}'`,
      'printf "argv %s\\n" "$*" >> "$log"',
      'printf "cwd %s\\n" "$PWD" >> "$log"',
      'env | sed "s/^/env /" >> "$log"',
      'if [ "$1" = deploy ]; then',
      '  printf "output %s\\n" "$(cat .vercel/output/build.json 2>/dev/null)" >> "$log"',
      '  printf "page %s\\n" "$(tr -d "\\n" < .vercel/output/static/index.html)" >> "$log"',
      '  mkdir -p .vercel && echo "{}" > .vercel/project.json',
      `  cat '${join(bin, 'deploy.out')}'; exit ${String(deploy.status)}`,
      'fi',
      `if [ "$1" = inspect ]; then cat '${join(bin, 'inspect.out')}'; exit ${String(inspect.status)}; fi`,
      'exit 2',
    ].join('\n'),
  );
  chmodSync(join(bin, 'vercel'), 0o755);
  const lines = (kind: string): string[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${kind} `))
          .map((line) => line.slice(kind.length + 1))
      : [];
  return { path: `${bin}:${process.env['PATH'] ?? ''}`, log, lines };
}

export const settings = (path: string): Record<string, string> => ({
  PATH: path,
  HOME: process.env['HOME'] ?? '',
  VERCEL_ORG_ID: ORG,
  VERCEL_PROJECT_ID: PROJECT,
  GOTRUE_URL: authUrl,
  OPS_ASTRO_TOKEN: CANARY,
  DATABASE_URL: `postgres://app:${CANARY}@127.0.0.1:1/never`,
  DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
});

export const clean = (): Promise<string[]> => Promise.resolve([]);
