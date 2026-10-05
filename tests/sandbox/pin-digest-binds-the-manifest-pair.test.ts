// SPDX-License-Identifier: AGPL-3.0-only
//
// I4 (docs/plan/sandbox-contract.md, section 3): the pin is refused unless
// the digest of `package.json` and `package-lock.json` together, in the
// tree as built, equals the site entry's. The digest is the sha256 of each
// file's length (8 bytes, big-endian) and bytes, `package.json` first, so
// bytes moved from one file to the other change it. A site entry with no
// image id (a pin being made) is refused `no pin` first.

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkPin, pinDigest } from '../../packages/core-sandbox/src/pin-digest.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const MANIFEST = bytes('{"name":"site","version":"1.0.0"}');
const LOCK = bytes('{"lockfileVersion":3,"packages":{}}');
const entry = (lockfile: string, image = `sha256:${'b'.repeat(64)}`) => ({
  lockfile,
  image,
  attempt: 1,
  commit: image === '' ? 'e'.repeat(40) : '',
  env: [],
});
const tree = (files: Record<string, Uint8Array>) => new Map(Object.entries(files));

const length = (n: number) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
};

it('is the sha256 of each length and bytes, package.json first', () => {
  const expected = createHash('sha256')
    .update(length(MANIFEST.length))
    .update(MANIFEST)
    .update(length(LOCK.length))
    .update(LOCK)
    .digest('hex');
  expect(pinDigest(MANIFEST, LOCK)).toBe(`sha256:${expected}`);
});

it('changes when bytes move between the two files or the order swaps', () => {
  expect(pinDigest(bytes('ab'), bytes('c'))).not.toBe(pinDigest(bytes('a'), bytes('bc')));
  expect(pinDigest(LOCK, MANIFEST)).not.toBe(pinDigest(MANIFEST, LOCK));
});

it("passes a tree whose pair hashes to the entry's digest", () => {
  const files = tree({ 'package.json': MANIFEST, 'package-lock.json': LOCK, 'a.md': bytes('x') });
  expect(checkPin(files, entry(pinDigest(MANIFEST, LOCK)))).toEqual({ ok: true });
});

it('refuses a tree whose pair hashes to another digest, or that lacks either file', () => {
  const pinned = entry(pinDigest(MANIFEST, LOCK));
  const mismatch = { ok: false, reason: 'pin mismatch', why: 'pin digest' };
  expect(
    checkPin(tree({ 'package.json': MANIFEST, 'package-lock.json': bytes('{}') }), pinned),
  ).toEqual(mismatch);
  expect(checkPin(tree({ 'package.json': MANIFEST }), pinned)).toEqual(mismatch);
  expect(checkPin(tree({ 'package-lock.json': LOCK }), pinned)).toEqual(mismatch);
  expect(
    checkPin(tree({ 'sub/package.json': MANIFEST, 'sub/package-lock.json': LOCK }), pinned),
  ).toEqual(mismatch);
});

it('refuses a site whose pin has no image id with no pin, before the digest', () => {
  const files = tree({ 'package.json': MANIFEST, 'package-lock.json': LOCK });
  expect(checkPin(files, entry(pinDigest(MANIFEST, LOCK), ''))).toEqual({
    ok: false,
    reason: 'no pin',
    why: 'pin image',
  });
});

it('refuses a missing file even when the pin was made from an empty one', () => {
  const empty = new Uint8Array();
  const mismatch = { ok: false, reason: 'pin mismatch', why: 'pin digest' };
  expect(checkPin(tree({ 'package-lock.json': LOCK }), entry(pinDigest(empty, LOCK)))).toEqual(
    mismatch,
  );
  expect(checkPin(tree({ 'package.json': MANIFEST }), entry(pinDigest(MANIFEST, empty)))).toEqual(
    mismatch,
  );
});
