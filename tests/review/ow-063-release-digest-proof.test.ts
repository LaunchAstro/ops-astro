// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildOutputProblems, outputDigest, stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, storedArtefact } from '../../scripts/ops/promotion.ts';

it('changing release files cannot retain its recorded digest', () => {
  const store = mkdtempSync(join(tmpdir(), 'sol-ow063-digest-'));
  try {
    const version = '0123456789ab';
    const out = join(store, artefactName(version));
    const func = join(out, 'functions', 'api.func');
    mkdirSync(func, { recursive: true });
    mkdirSync(join(out, 'static'));
    writeFileSync(join(out, 'config.json'), JSON.stringify({ version: 3, routes: [] }));
    writeFileSync(
      join(func, '.vc-config.json'),
      JSON.stringify({
        runtime: 'nodejs24.x',
        handler: 'index.mjs',
        regions: ['syd1'],
      }),
    );
    writeFileSync(join(func, 'index.mjs'), 'export {};');
    const a = join(out, 'static', 'a.bin');
    const b = join(out, 'static', 'b.html');
    const page = '<script>globalThis.changedRelease = true</script>';
    // Both trees feed x\0content\0 into the hash: the original content
    // contains exactly the framing of the subsequently added file.
    writeFileSync(a, Buffer.from(`original\0static/b.html\0${page}`));
    const stamped = stampOutput(out, version);
    expect(buildOutputProblems(out)).toEqual([]);
    expect(storedArtefact(version, store)).toMatchObject({ digest: stamped.digest });
    const originalStamp = readFileSync(join(out, 'build.json'));

    writeFileSync(a, 'original');
    writeFileSync(b, page);

    expect(buildOutputProblems(out)).toEqual([]);
    expect(readFileSync(join(out, 'build.json'))).toEqual(originalStamp);
    expect({ digest: outputDigest(out), selected: storedArtefact(version, store) }).toMatchObject({
      selected: expect.any(String),
    });
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
