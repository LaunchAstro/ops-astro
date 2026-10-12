// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof drives a real script in a disposable copy */
// Only disposable copies are mutated. These proofs failed at 7b05ed6.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-expect-error -- the relay is a plain JavaScript module
import { serverName, firstBytes } from '../../scripts/ops/egress.mjs';

const root = resolve(import.meta.dirname, '../..');
function withCopy(work: (copy: string) => void): void {
  const copy = mkdtempSync(join(tmpdir(), 'sol-1402-proof-'));
  try {
    for (const dir of ['apps', 'packages', 'scripts'])
      cpSync(join(root, dir), join(copy, dir), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    return work(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
function parity(copy: string) {
  return spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
    cwd: copy,
    encoding: 'utf8',
    timeout: 60_000,
  });
}
function refused(copy: string): unknown {
  const script = `
    import { askedAgain } from './packages/core-commands/src/commands/prepare.ts';
    import { declarationOf } from './packages/core-wire/src/index.ts';
    const tx = { businessId: '00000000-0000-4000-8000-000000000001', query: async () => [] };
    const session = { personId: '00000000-0000-4000-8000-000000000002', actorId: '00000000-0000-4000-8000-000000000003', roleKey: 'member' };
    const result = await askedAgain(tx, { session, declaration: declarationOf('task.update') }, '00000000-0000-4000-8000-000000000004');
    process.stdout.write(JSON.stringify({ code: result?.refusal?.code ?? null }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: copy,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).code;
}

test(
  'parity rejects write enforcement removed after the grant query',
  () =>
    withCopy((copy) => {
      assert.equal(parity(copy).status, 0, 'control: unchanged parity passes');
      assert.equal(
        refused(copy),
        'SCOPE_NOT_GRANTED',
        'control: no grants refuses the actual helper',
      );
      const path = join(copy, 'packages/core-commands/src/commands/prepare.ts');
      const original = readFileSync(path, 'utf8');
      const mutant = original.replace('if (authorised.ok) return {};', 'if (true) return {};');
      assert.notEqual(mutant, original, 'the mutation applied');
      writeFileSync(path, mutant);
      assert.equal(refused(copy), null, 'the mutant admits a caller holding no grants');
      const result = parity(copy);
      assert.equal(
        result.status,
        1,
        `Parity still passes with write enforcement removed: ${result.stderr}`,
      );
    }),
  300_000,
);

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
function hello(name: string, padding: number): Buffer {
  const host = Buffer.from(name);
  const sni = Buffer.concat([
    u16(0),
    u16(host.length + 5),
    u16(host.length + 3),
    Buffer.from([0]),
    u16(host.length),
    host,
  ]);
  const ext = Buffer.concat([u16(21), u16(padding), Buffer.alloc(padding), sni]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 1]),
    Buffer.from([1, 0]),
    u16(ext.length),
    ext,
  ]);
  return Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
}
const record = (body: Buffer) => Buffer.concat([Buffer.from([0x16, 3, 1]), u16(body.length), body]);
test('a full-size hello fragmented across records survives TCP chunking', () => {
  const host = 'api.example.test';
  const base = hello(host, 0).length;
  const whole = hello(host, 16_384 - base);
  assert.equal(whole.length, 16_384);
  const framed = Buffer.concat([record(whole.subarray(0, 16_380)), record(whole.subarray(16_380))]);
  assert.equal(serverName(framed), host, 'control: the complete fragmented hello parses');
  // oxlint-disable-next-line unicorn/prefer-event-target -- a net.Socket stand-in, which is an EventEmitter
  const socket = Object.assign(new EventEmitter(), { pause() {}, setTimeout() {}, destroy() {} });
  let answer: unknown = 'waiting';
  firstBytes(
    socket,
    (bytes: Buffer) => {
      const name = serverName(bytes);
      return name ? [name, 443] : null;
    },
    (pair: unknown) => {
      answer = pair;
    },
  );
  socket.emit('data', framed.subarray(0, 16_389));
  if (answer === 'waiting') socket.emit('data', framed.subarray(16_389));
  assert.deepEqual(
    answer,
    [host, 443],
    'the one-record cap drops a valid fragmented hello before its last bytes arrive',
  );
});

test('the CLI executes through a linked entry path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-1402-cli-link-'));
  try {
    const direct = join(root, 'apps/cli/main.ts');
    const linked = join(dir, 'cli.ts');
    symlinkSync(direct, linked);
    const run = (file: string) =>
      spawnSync(process.execPath, [file, '--help'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
    const control = run(direct);
    assert.equal(control.status, 0, control.stderr);
    assert.ok(control.stdout.length + control.stderr.length > 0, 'control: direct CLI prints help');
    const actual = run(linked);
    assert.equal(actual.status, control.status);
    assert.ok(
      actual.stdout + actual.stderr === control.stdout + control.stderr,
      'linked CLI silently exits instead of printing help',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test(
  'parity inspects a browser helper imported outside its two source directories',
  () =>
    withCopy((copy) => {
      assert.equal(parity(copy).status, 0, 'control: unchanged parity passes');
      writeFileSync(
        join(copy, 'packages/browser-helper.mjs'),
        "export const plantedWrite = () => fetch('/api/b/alpha/uncatalogued-write', { method: 'POST' });\n",
      );
      appendFileSync(
        join(copy, 'apps/web/src/main.tsx'),
        "\nimport { plantedWrite } from '../../../packages/browser-helper.mjs';\nplantedWrite();\n",
      );
      // Prove this module actually ships, rather than merely leaving an unused file beside the app.
      const buildScript = `
    import { build } from 'vite';
    import react from '@vitejs/plugin-react';
    import { resolve } from 'node:path';
    let shipped = false;
    await build({ configFile: false, root: resolve('apps/web'), logLevel: 'silent', publicDir: false,
      resolve: { alias: { '@launchastro/ui': resolve('packages/ui/src/index.ts') } },
      plugins: [react(), { name: 'sol-proof-graph', generateBundle() {
        shipped = [...this.getModuleIds()].some(id => id.endsWith('/packages/browser-helper.mjs'));
      } }], build: { write: false } });
    if (!shipped) throw new Error('the planted helper did not ship');
  `;
      const built = spawnSync(process.execPath, ['--input-type=module', '-e', buildScript], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(built.status, 0, built.stderr);
      const result = parity(copy);
      assert.equal(result.status, 1, `Parity passes the imported browser write: ${result.stderr}`);
      assert.match(result.stdout, /browser-helper\.mjs sends a request itself/u);
    }),
  300_000,
);

test(
  'each agent bearer must execute exactly once rather than sharing a total',
  () =>
    withCopy((copy) => {
      assert.equal(parity(copy).status, 0, 'control: unchanged parity passes');
      const path = join(copy, 'apps/api/app.ts');
      const original = readFileSync(path, 'utf8');
      let mutant = original.replace(
        'const answer = await run(options.database, businessId, call, {',
        "const answer = declaration.name === 'task.update' ? { recordId: 'r', revision: 1 } : await run(options.database, businessId, call, {",
      );
      mutant = mutant.replace(
        'const execute = executorFor(declaration.name, options, agentExecutor);',
        `const execute = executorFor(declaration.name, options, agentExecutor);
      if (declaration.name === 'task.update') await execute(options.database, businessId, presented, context.req.header(DELEGATION_HEADER), { ...body, command: declaration.name });`,
      );
      assert.notEqual(mutant, original, 'both route mutations applied');
      assert.ok(mutant.includes("declaration.name === 'task.update' ? { recordId"));
      assert.ok(mutant.includes("if (declaration.name === 'task.update') await execute"));
      writeFileSync(path, mutant);
      const script = `
    import { createApi } from './apps/api/app.ts';
    import { PREFIX, pathOf } from './packages/core-wire/src/index.ts';
    let calls = 0;
    const execute = async () => { calls++; return { recordId: 'r', revision: 1 }; };
    const api = createApi({ database: {}, verify: async () => ({ subject: 'parity' }), resolveBusiness: async () => 'business', executeRead: execute, executeCommand: execute, executeAgentCommand: execute, executeCredentialCommand: execute });
    const counts = [];
    for (const bearer of ['parity.probe.token', 'c'.repeat(43)]) {
      calls = 0;
      await api.fetch(new Request('http://parity' + PREFIX.agent + 'b' + pathOf('task.update'), { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: '{}' }));
      counts.push(calls);
    }
    process.stdout.write(JSON.stringify(counts));
  `;
      const reached = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: copy,
        encoding: 'utf8',
      });
      assert.equal(reached.status, 0, reached.stderr);
      assert.deepEqual(
        JSON.parse(reached.stdout),
        [2, 0],
        'the JWT runs twice and the credential never runs',
      );
      const result = parity(copy);
      assert.equal(
        result.status,
        1,
        `Parity pools the two probes and accepts the double execution and missing credential route: ${result.stderr}`,
      );
    }),
  300_000,
);
