// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { outputDigest, stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote } from '../../scripts/ops/promotion.ts';

it('separate preview processes build the commit each successful record names', async () => {
  const module = pathToFileURL(resolve('scripts/ops/preview.ts')).href;
  const versionA = 'a'.repeat(40);
  const versionB = 'b'.repeat(40);
  let branchHead = '';
  const children: ReturnType<typeof spawn>[] = [];
  const run = (version: string) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { requestPreview } from ${JSON.stringify(module)};
      const version = ${JSON.stringify(version)};
      const outcome = await requestPreview({version}, {
        env: {PREVIEWS_VERCEL_PROJECT_ID:'prj_solpreview', VERCEL_PROJECT_ID:'prj_solstaging',
          PREVIEW_DEPLOY_HOOK:'https://api.vercel.com/v1/integrations/deploy/prj_solpreview/syntheticHook'},
        push: () => {process.send({kind:'push',version}); return true;},
        post: () => new Promise(resolve => {
          process.once('message', () => resolve(Response.json({job:{id:'job'+version[0]}})));
          process.send({kind:'post'});
        })
      });
      process.send({kind:'result',outcome}, () => process.disconnect());
    `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    children.push(child);
    let posted!: () => void;
    const posting = new Promise<void>((r) => {
      posted = r;
    });
    let result!: (value: { kind: string; record: { version: string } }) => void;
    const outcome = new Promise<{ kind: string; record: { version: string } }>((r) => {
      result = r;
    });
    child.on(
      'message',
      (message: {
        kind: string;
        version: string;
        outcome: { kind: string; record: { version: string } };
      }) => {
        if (message.kind === 'push') branchHead = message.version;
        if (message.kind === 'post') posted();
        if (message.kind === 'result') result(message.outcome);
      },
    );
    return { child, posting, outcome };
  };
  try {
    const first = run(versionA);
    await first.posting;
    const second = run(versionB);
    // A safe implementation may queue or refuse the second process.
    await Promise.race([second.posting, second.outcome, new Promise((r) => setTimeout(r, 500))]);
    const firstBuilt = branchHead;
    first.child.send('deliver');
    const a = await first.outcome;
    const next = await Promise.race([
      second.posting.then(() => 'post'),
      second.outcome.then(() => 'done'),
    ]);
    const secondBuilt = branchHead;
    if (next === 'post') second.child.send('deliver');
    const b = await second.outcome;
    if (b.kind === 'requested') expect(secondBuilt).toBe(b.record.version);
    if (a.kind === 'requested')
      expect(firstBuilt, 'the first hook arrives after another process pushed').toBe(
        a.record.version,
      );
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}, 20_000);

it('a store write after the final digest cannot change the promoted bytes', () => {
  const store = mkdtempSync(join(tmpdir(), 'sol-d2-promote-'));
  try {
    const version = '0123456789ab';
    const artefact = join(store, artefactName(version));
    mkdirSync(artefact);
    const page = join(artefact, 'index.html');
    writeFileSync(page, 'validated bytes');
    stampOutput(artefact, version);
    const validated = outputDigest(artefact);
    const current = join(store, 'current');
    let served = '';
    const outcome = promote(
      {
        version,
        store,
        current,
        line: 'Tried on staging.',
        dryRun: false,
        api: { manager: 'docker', name: 'api' },
        auth: { manager: 'docker', name: 'auth' },
      },
      {
        services: () => [
          { manager: 'docker', name: 'api', running: false },
          { manager: 'docker', name: 'auth', running: false },
        ],
        migrate: () => true,
        point: (link, selected) => {
          // An independent writer runs after the re-digest, before the production link is installed.
          const writer = spawnSync(process.execPath, [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], "unvalidated bytes")',
            page,
          ]);
          expect(writer.status).toBe(0);
          symlinkSync(selected, link);
        },
        start: (service) => {
          if (service.name === 'api') served = readFileSync(join(current, 'index.html'), 'utf8');
        },
      },
    );
    if (outcome.kind === 'promoted') {
      expect(served).toBe('validated bytes');
      expect(outputDigest(current)).toBe(validated);
    } else expect(served).toBe('');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
