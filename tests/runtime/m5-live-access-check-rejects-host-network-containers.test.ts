// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's independent proof. No Docker process or target is contacted.
import { test, expect, vi } from 'vitest';
const proof = vi.hoisted(() => ({
  cases: new Map<string, () => unknown>(),
  formats: [] as string[],
}));
vi.mock('vitest', async (original) => {
  const actual = await original<typeof import('vitest')>();
  const capture = (name: string, run: () => unknown) => {
    proof.cases.set(name, run);
  };
  capture.skip = capture;
  return { ...actual, it: capture };
});
vi.mock('node:child_process', () => ({
  execFileSync: (_command: string, args: string[]) => {
    const format = args.at(-1)!;
    proof.formats.push(format);
    // A Docker container with NetworkMode=host has no published-port bindings.
    // Langfuse can listen on the host's 0.0.0.0:3000 with these inspect values.
    if (format.includes('NetworkMode')) return 'host\n';
    if (format.includes('RestartPolicy'))
      return Array.from({ length: 6 }, () => 'always null').join('\n');
    if (format.includes('.Config.Env'))
      return args.includes('langfuse-langfuse-web-1')
        ? 'AUTH_DISABLE_SIGNUP=true;LANGFUSE_MEDIA_UPLOAD_ENABLED=false;TELEMETRY_ENABLED=false;\n'
        : 'LANGFUSE_MEDIA_UPLOAD_ENABLED=false;TELEMETRY_ENABLED=false;\n';
    throw new Error(`Unexpected inspect format: ${format}`);
  },
}));
await import('./m5-trace-live.test.ts');
test('the owner-only access check rejects containers on the host network', async () => {
  const run = proof.cases.get(
    'the existing M5 target listens on loopback only, restarts with Docker and keeps signup and media upload off',
  );
  expect(run).toBeTypeOf('function');
  await expect(Promise.resolve().then(() => run!())).rejects.toThrow();
});
