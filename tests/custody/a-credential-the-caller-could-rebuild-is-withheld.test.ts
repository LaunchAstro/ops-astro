// SPDX-License-Identifier: AGPL-3.0-only
//
// On the reference path the caller never holds the token, so custody judges
// an echo by what the caller keeps: the declared fields, which the caller may
// read whole, decoded or joined in any order. An answer the whole credential
// can be rebuilt from is withheld; one that only resembles it passes. Custody
// runs as its own process, and a local stand-in answers in place of either
// provider.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  callConnector,
  siteOperation,
  type CallDependencies,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import {
  siteCustody,
  siteDestination,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const LONG = `proof-canary-${hex(18)}`;
const SHORT = hex(6);
const FIXED = 'abcdefghijkl';
const TOKEN_SHAPED = `github_pat_${hex(41)}`;

let server: Server;
let folder: string;
let body = '{}';
let contentType = 'application/json';
const seen: string[] = [];
const custodies = new Map<string, Custody>();

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(request.url ?? '');
      response.writeHead(200, { 'content-type': contentType }).end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'rebuilt-credential-'));
  for (const [at, key] of [LONG, SHORT, FIXED, TOKEN_SHAPED].entries()) {
    const credentialsFile = join(folder, `credentials-${String(at)}.json`);
    const entry = (ref: string) => ({
      ref,
      kind: 'api_key',
      account: 'proof',
      destination: ref,
      header: 'authorization',
      value: key,
    });
    writeFileSync(credentialsFile, JSON.stringify([entry('source_control'), entry('hosting')]), {
      mode: 0o600,
    });
    // oxlint-disable-next-line no-await-in-loop
    const custody = await startCustody({
      credentialsFile,
      destinations: [siteDestination('source_control', origin), siteDestination('hosting', origin)],
    });
    custodies.set(key, custody);
  }
}, 60_000);

afterAll(async () => {
  await Promise.all([...custodies.values()].map(async (custody) => await custody.stop()));
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

const writeParams = {
  repository: 'agency/site',
  path: 'src/pages/about.astro',
  message: 'm',
  content: 'PHA+',
  sha: 'abc',
  branch: 'main',
};
const readParams = { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' };
const answer = (): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': contentType },
  body: new TextEncoder().encode(body),
});

/** The call's ports for one held key: borrowed (the token in hand) or by reference to custody. */
const held = (canary: string) => ({
  canary,
  dependencies: (reference: boolean): CallDependencies => ({
    transport: () => Promise.resolve(answer()),
    resolve: () => Promise.resolve(['140.82.112.6']),
    credential: (ref) => Promise.resolve(reference ? { ref } : canary),
    custody: siteCustody(custodies.get(canary)!),
    record: () => {},
  }),
});

it('a split credential remains withheld when JSON field order differs from schema order', async () => {
  const { canary, dependencies } = held(LONG);
  contentType = 'application/json';
  // Each field holds only part of the canary; the schema reads content.sha before commit.sha.
  body = JSON.stringify({
    commit: { sha: canary.slice(12) },
    content: { sha: canary.slice(0, 12) },
  });
  const legacy = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(false),
  );
  expect(legacy).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  // A boolean assertion avoids printing the canary.
  const leaked = result.kind === 'ok' && Object.values(result.value).join('').includes(canary);
  expect(leaked).toBe(false);
  expect(result.kind).toBe('unknown');
});

it('an undeclared string cannot hide a split credential from the schema-filtered result', async () => {
  const { canary, dependencies } = held(LONG);
  contentType = 'application/json';
  body = JSON.stringify({
    content: { sha: canary.slice(0, 12) },
    ignored: 'separator',
    commit: { sha: canary.slice(12) },
  });
  expect(
    await callConnector(siteOperation('site.publish'), writeParams, dependencies(false)),
  ).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  const leaked = result.kind === 'ok' && Object.values(result.value).join('').includes(canary);
  expect(leaked).toBe(false);
});

it('a valid twelve-character credential split into two six-character fields stays withheld', async () => {
  const { canary, dependencies } = held(SHORT);
  contentType = 'application/json';
  body = JSON.stringify({ content: { sha: canary.slice(0, 6) }, commit: { sha: canary.slice(6) } });
  const legacy = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(false),
  );
  expect(legacy).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  // Check the leak as a boolean so a failure never prints the credential.
  const leaked = result.kind === 'ok' && Object.values(result.value).join('') === canary;
  expect(leaked).toBe(false);
  expect(result).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
});

it('pieces of the credential each encoded on their own, in two kept fields, are withheld', async () => {
  const { dependencies } = held(FIXED);
  contentType = 'application/json';
  // btoa('abcde') and btoa('fghijkl'); a percent escape inside one piece; one base64 text cut mid-group.
  const splits = [
    ['YWJjZGU=', 'ZmdoaWprbA=='],
    ['ZmdoaWprbA==', 'YWJjZGU='],
    ['abc%64ef', 'ghijkl'],
    ['YWJjZG', 'VmZ2hpamts'],
    ['abcdef%6', '7hijkl'],
  ];
  for (const [first = '', second = ''] of splits) {
    body = JSON.stringify({ content: { sha: first }, commit: { sha: second }, other: 'x' });
    // oxlint-disable-next-line no-await-in-loop
    const result = await callConnector(
      siteOperation('site.publish'),
      writeParams,
      dependencies(true),
    );
    expect(result, `${first} ${second}`).toEqual({
      kind: 'unknown',
      code: 'PROVIDER_CREDENTIAL_ECHOED',
    });
  }
});

/** A base64 file body as the provider writes it, a line break every sixty characters. */
const fileContent = (text: string) =>
  Buffer.from(text)
    .toString('base64')
    .replaceAll(/(.{60})/gu, '$1\n');

it('an answer of ordinary hashes and ids passes for a twelve-character key and a token-shaped key (control)', async () => {
  for (const key of [SHORT, TOKEN_SHAPED]) {
    const { dependencies } = held(key);
    const commit = hex(20);
    const blob = hex(20);
    const content = fileContent(`<h1>About us</h1>\n<p>${hex(200)}</p>\n`);
    const id = `dpl_${randomBytes(18).toString('base64url')}`;
    contentType = 'application/json';
    body = JSON.stringify({ content: { sha: blob, size: 120 }, commit: { sha: commit } });
    // oxlint-disable-next-line no-await-in-loop
    const published = await callConnector(
      siteOperation('site.publish'),
      writeParams,
      dependencies(true),
    );
    expect(published).toEqual({ kind: 'ok', value: { 'content.sha': blob, 'commit.sha': commit } });
    body = JSON.stringify({ sha: blob, content, encoding: 'base64', name: 'about.astro' });
    // oxlint-disable-next-line no-await-in-loop
    const source = await callConnector(
      siteOperation('site.source.read'),
      readParams,
      dependencies(true),
    );
    expect(source).toEqual({ kind: 'ok', value: { sha: blob, content, encoding: 'base64' } });
    body = JSON.stringify({
      id,
      readyState: 'READY',
      target: 'production',
      meta: { githubCommitSha: commit },
      url: 'site.example.com',
    });
    // oxlint-disable-next-line no-await-in-loop
    const deployment = await callConnector(
      siteOperation('site.deployment.read'),
      { deployment: id },
      dependencies(true),
    );
    expect(deployment).toEqual({
      kind: 'ok',
      value: { id, readyState: 'READY', target: 'production', 'meta.githubCommitSha': commit },
    });
  }
});

it('a sha sharing the key’s first six or eight characters, and a near miss of the key, pass (control)', async () => {
  contentType = 'application/json';
  const short = held(SHORT);
  const eight = `${SHORT.slice(0, 8)}${hex(16)}`;
  const six = `${SHORT.slice(0, 6)}${hex(17)}`;
  body = JSON.stringify({ content: { sha: eight }, commit: { sha: six } });
  expect(
    await callConnector(siteOperation('site.publish'), writeParams, short.dependencies(true)),
  ).toEqual({ kind: 'ok', value: { 'content.sha': eight, 'commit.sha': six } });
  // No hex character is `l`, so no other kept value can finish the key.
  const fixed = held(FIXED);
  const commit = hex(20);
  for (const near of [FIXED.slice(0, -1), `${FIXED.slice(0, -1)}X`]) {
    body = JSON.stringify({ content: { sha: near }, commit: { sha: commit } });
    // oxlint-disable-next-line no-await-in-loop
    const result = await callConnector(
      siteOperation('site.publish'),
      writeParams,
      fixed.dependencies(true),
    );
    expect(result, near).toEqual({
      kind: 'ok',
      value: { 'content.sha': near, 'commit.sha': commit },
    });
  }
});

it('the key whole in an undeclared field is dropped, not withheld, and the kept answer is clean (control)', async () => {
  const { canary, dependencies } = held(LONG);
  contentType = 'application/json';
  const commit = hex(20);
  const blob = hex(20);
  body = JSON.stringify({ content: { sha: blob }, commit: { sha: commit, note: canary } });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  expect(result).toEqual({ kind: 'ok', value: { 'content.sha': blob, 'commit.sha': commit } });
  expect(JSON.stringify(result).includes(canary)).toBe(false);
});
