// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-promise-executor-return -- explicit two-process schedule */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('preview processes with separate temporary directories still build their recorded commits', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol-d2-fix2-preview-'));
  mkdirSync(join(scratch, 'a'));
  mkdirSync(join(scratch, 'b'));
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
      {
        env: { ...process.env, TMPDIR: join(scratch, version[0]!) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
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
    expect(a.kind, 'the valid first request must finish successfully').toBe('requested');
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
    rmSync(scratch, { recursive: true, force: true });
  }
}, 20_000);
