// SPDX-License-Identifier: AGPL-3.0-only
//
// A site file that starts with a UTF-8 byte-order mark keeps it: the source
// read decodes it as text, the proposal's write sends its bytes, and the
// advance publishes the file with it.

import { expect, it } from 'vitest';
import {
  contentDigest,
  mergeAndFind,
  proposeSource,
  readSiteSource,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';
import { AFTER, APPROVED, BEFORE, binding, proposal, proposed } from './c80-site-provider.ts';

it('preserves a UTF-8 byte-order mark in the source read, the proposed write and the published file', async () => {
  const site = proposed();
  const before = '\uFEFF' + BEFORE;
  const after = '\uFEFF' + AFTER;
  site.state.content = before;
  site.state.branches = ['main'];
  site.state.request = undefined;
  const pin = {
    ...APPROVED,
    preImageDigest: contentDigest(before),
    change: { files: [{ path: binding.path, before, after }] },
  };
  const versionDigest = versionDigestOf(pin);
  const bomBinding = {
    ...binding,
    change: { before, after },
    proposal: { ...binding.proposal, versionDigest },
  };
  expect(await readSiteSource(bomBinding, site.deps)).toMatchObject({
    value: { content: before },
  });
  expect(await proposeSource({ ...proposal, after, versionDigest }, site.deps)).toMatchObject({
    kind: 'ok',
  });
  const write = site.sent.find((sent) => sent.method === 'PUT');
  expect(Buffer.from(write?.body['content'] ?? '', 'base64').subarray(0, 3)).toEqual(
    Buffer.from([0xef, 0xbb, 0xbf]),
  );
  expect(await mergeAndFind(bomBinding, { ...pin, versionDigest }, site.deps)).toMatchObject({
    kind: 'ok',
  });
  expect(site.state.content).toBe(after);
});
