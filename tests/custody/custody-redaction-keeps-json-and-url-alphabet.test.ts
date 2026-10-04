// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startCustody } from '../../packages/core-custody/src/custody.ts';
import { readReplayAnswer } from '../../packages/core-connectors/src/replay.ts';

const ROOT = resolve(import.meta.dirname, '../..');

/** The synthetic key's credentials file in `folder`. */
function writeCredentials(folder: string, key: string): string {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'synthetic_key',
        kind: 'api_key',
        account: 'synthetic-account',
        destination: 'synthetic',
        header: 'authorization',
        value: key,
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

/** Custody and the escaped-credential suite copied into `folder`, the URL alphabet branch removed. */
function copyWithoutUrlAlphabet(folder: string): string {
  cpSync(join(ROOT, 'packages/core-custody'), join(folder, 'packages/core-custody'), {
    recursive: true,
  });
  const testFile = 'tests/custody/custody-redacts-escaped-credential.test.ts';
  cpSync(join(ROOT, testFile), join(folder, testFile));
  symlinkSync(join(ROOT, 'node_modules'), join(folder, 'node_modules'), 'dir');
  const product = join(folder, 'packages/core-custody/src/custody-main.ts');
  const source = readFileSync(product, 'utf8');
  const branch = "return [stable, stable.replaceAll('+', '-').replaceAll('/', '_')];";
  expect(source.includes(branch), 'negative control must remove the URL alphabet branch').toBe(
    true,
  );
  writeFileSync(product, source.replace(branch, 'return [stable];'));
  writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(folder, 'vitest.config.mts'),
    'export default { test: { include: ["tests/**/*.test.ts"], maxWorkers: 1 } };',
  );
  return testFile;
}

it('mixed percent matching preserves JSON delimiters outside string values', async () => {
  // Synthetic credential only. The provider's text contains no whole credential.
  const key = 'canary",';
  const answer = { text: '%63anary', model: 'replay-1', usage: { input: 1, output: 1 } };
  expect(decodeURIComponent(answer.text).includes(key)).toBe(false);
  const folder = mkdtempSync(join(tmpdir(), 'sol-750-json-'));
  const server = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => response.end(JSON.stringify(answer)));
  });
  let custody: Awaited<ReturnType<typeof startCustody>> | undefined;
  try {
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const credentialsFile = writeCredentials(folder, key);
    custody = await startCustody({
      credentialsFile,
      destinations: [{ key: 'synthetic', origin: `http://127.0.0.1:${String(address.port)}` }],
    });
    const outcome = await custody.dispatch('synthetic_key', {
      destination: 'synthetic',
      path: '/v1/complete',
      method: 'POST',
      body: '{}',
      timeoutMs: 2_000,
      maxResponseBytes: 4_096,
    });
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    let decoded: unknown;
    let validJson = true;
    try {
      decoded = JSON.parse(outcome.outbound.body);
    } catch {
      validJson = false;
    }
    expect(validJson, 'redaction must preserve valid JSON and its usage fields').toBe(true);
    expect(decoded).toEqual(answer);
  } finally {
    await custody?.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => {
      server.close(() => done());
    });
    rmSync(folder, { recursive: true, force: true });
  }
});

it('the named base64url cases reject removal of URL alphabet support', () => {
  // Run the actual added cases against a temporary, deliberately broken copy.
  // No tracked product file is changed. Standard base64 remains supported.
  const folder = mkdtempSync(join(tmpdir(), 'sol-750-url-mutation-'));
  try {
    const testFile = copyWithoutUrlAlphabet(folder);
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const run = spawnSync(
      process.execPath,
      [cli, 'run', testFile, '-t', 'the key in .*base64url', '--reporter=verbose'],
      {
        cwd: folder,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          TMPDIR: folder,
          DATABASE_URL: '',
          DATABASE_ADMIN_URL: '',
          NO_COLOR: '1',
        },
      },
    );
    if (run.error !== undefined) throw run.error;
    const output = run.stdout + run.stderr;
    const executed =
      output.includes('the key in base64url is redacted from the answer') &&
      output.includes(
        'the key in base64url of longer text, two bytes in is redacted from the answer',
      );
    expect(executed, 'negative control must execute both named cases').toBe(true);
    expect(
      run.status !== 0,
      'the base64url cases must fail when URL alphabet redaction is removed',
    ).toBe(true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 40_000);

/** The real custody child's reply for one bounded synthetic provider answer. */
async function returnedAnswer(answer: string, key: string): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'sol-750-json-'));
  const server = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => response.end(answer));
  });
  let custody: Awaited<ReturnType<typeof startCustody>> | undefined;
  try {
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const credentialsFile = writeCredentials(folder, key);
    custody = await startCustody({
      credentialsFile,
      destinations: [{ key: 'synthetic', origin: `http://127.0.0.1:${String(address.port)}` }],
    });
    const outcome = await custody.dispatch('synthetic_key', {
      destination: 'synthetic',
      path: '/v1/complete',
      method: 'POST',
      body: '{}',
      timeoutMs: 2_000,
      maxResponseBytes: 65_536,
    });
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
    return outcome.outbound.body;
  } finally {
    await custody?.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => {
      server.close(() => done());
    });
    rmSync(folder, { recursive: true, force: true });
  }
}

it('valid nested provider metadata preserves the answer and usage', async () => {
  // Synthetic credential only. The provider's text contains no whole credential.
  const key = 'synthetic-canary-key';
  // This body is about 6 KB, within the actual replay operation's 64 KB limit.
  const depth = 3_000;
  const answer =
    '{"text":"ok","model":"replay-1","usage":{"input":1,"output":1},"metadata":' +
    '['.repeat(depth) +
    '0' +
    ']'.repeat(depth) +
    '}';
  expect(
    readReplayAnswer(JSON.parse(answer)),
    'original body satisfies the answer schema',
  ).toBeDefined();
  expect(answer.includes(key)).toBe(false);
  const body = await returnedAnswer(answer, key);
  expect(body.length, 'custody must retain a valid answer').toBe(answer.length);
  expect(readReplayAnswer(JSON.parse(body))).toEqual(readReplayAnswer(JSON.parse(answer)));
  expect(body === answer, 'innocent metadata must preserve the answer').toBe(true);
});

it.each([
  ['objects', (depth: number) => `${'{"a":'.repeat(depth)}0${'}'.repeat(depth)}`],
  ['arrays', (depth: number) => `${'['.repeat(depth)}0${']'.repeat(depth)}`],
] as const)(
  'an answer whose metadata nests 5,000 %s is kept whole, as the parse and write-back keep it',
  async (_shape, nest) => {
    const answer = `{"text":"ok","model":"replay-1","usage":{"input":1,"output":1},"metadata":${nest(5_000)}}`;
    const body = await returnedAnswer(answer, 'synthetic-canary-key');
    expect({ length: body.length, same: body === answer }).toEqual({
      length: answer.length,
      same: true,
    });
  },
);
