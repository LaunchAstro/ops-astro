// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill removes only the container it started, and passes only
// once that container is gone. A Docker stand-in answers every step as a
// healthy drill would, so each case changes one answer: the start refused
// (a name another drill holds), or the removal refused (the decrypted copy
// still running, named to the operator).

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

type Docker = (
  args: string[],
  input?: Buffer | AsyncIterable<Buffer>,
  options?: { detached: boolean },
) => Promise<{ code: number; stdout: string }>;
type DrillModule = {
  restoreDrill: (options: {
    fetchArchive: () => Promise<{ takenAt: string; body: Buffer }>;
    privateKey: string;
    scope: { business: string; client: string; person: string };
    docker: Docker;
  }) => Promise<Record<string, unknown>>;
};
const DRILL = '../../scripts/ops/drill-restore.mjs';
const SEAL = '../../scripts/ops/archive-seal.mjs';
const { restoreDrill } = (await import(
  /* @vite-ignore */
  DRILL
)) as DrillModule;
const { sealArchive } = (await import(
  /* @vite-ignore */
  SEAL
)) as {
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
};

const MAJOR = (
  JSON.parse(
    readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
  ) as { 'x-ops-astro': { productionDatabaseMajor: number } }
)['x-ops-astro'].productionDatabaseMajor;
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const sealed = sealArchive(Buffer.from('a made-up dump'), keys.publicKey);

/** Docker as a healthy drill sees it, but for the answers `fault` gives. */
function standIn(calls: string[][], fault: (args: string[]) => number | undefined): Docker {
  return async (args, input) => {
    calls.push(args);
    if (input !== undefined && !Buffer.isBuffer(input)) for await (const _ of input);
    const code = fault(args) ?? 0;
    const command = args.join(' ');
    let stdout = '';
    if (command.includes('show server_version_num')) stdout = `${MAJOR * 10_000}\n`;
    else if (command.includes('--list'))
      stdout = `; Dumped from database version: ${MAJOR}.1\n1; 2 3 TABLE DATA public tasks postgres\n`;
    else if (command.includes('string_agg')) stdout = 'public.tasks|0|0|1|1|2\n';
    return { code, stdout };
  };
}

const drill = (docker: Docker) =>
  restoreDrill({
    fetchArchive: () => Promise.resolve({ takenAt: '2026-10-01T00:00:00.000Z', body: sealed }),
    privateKey: keys.privateKey,
    scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
    docker,
  });

describe('the restore drill and its own container', () => {
  it('passes a healthy drill that removed its container', async () => {
    const calls: string[][] = [];
    const record = await drill(standIn(calls, () => 0));
    expect(record).toMatchObject({ outcome: 'passed', tables: 1 });
    expect(calls.at(-1)?.slice(0, 3)).toEqual(['rm', '-f', '-v']);
  });

  it('fails a drill whose container Docker would not remove, and names that container', async () => {
    const calls: string[][] = [];
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const record = await drill(standIn(calls, (args) => (args[0] === 'rm' ? 1 : undefined)));
    const told = said.mock.calls.join('');
    said.mockRestore();
    const name = calls[0]?.[calls[0].indexOf('--name') + 1] ?? '';
    expect(record['outcome'], 'a pass recorded while the restored copy still runs').toBe('failed');
    // The store's stages have no removal of their own: the container is the start's.
    expect(record['stage']).toBe('start');
    expect(told).toContain(`docker rm -f -v ${name}`);
  });

  it('removes nothing when Docker refused to start the container under its name', async () => {
    const calls: string[][] = [];
    const record = await drill(standIn(calls, (args) => (args[0] === 'run' ? 125 : undefined)));
    expect(record).toMatchObject({ outcome: 'failed', stage: 'start' });
    expect(
      calls.filter((args) => args[0] === 'rm'),
      'a refused start removes the container another drill holds under that name',
    ).toEqual([]);
  });
});

describe('the restore drill and its container lifeline', () => {
  it('holds a lifeline into its container from the start until after the removal', async () => {
    const calls: string[][] = [];
    const ended: number[] = [];
    let options: unknown;
    const healthy = standIn(calls, () => 0);
    const record = await drill((args, input, given) => {
      if (args[0] === 'exec' && args.includes('sh')) {
        options = given;
        (input as NodeJS.ReadableStream).on('end', () => ended.push(calls.length));
      }
      return healthy(args, input);
    });
    expect(record).toMatchObject({ outcome: 'passed' });
    const name = calls[0]?.[calls[0].indexOf('--name') + 1] ?? '';
    // tini as PID 1 passes the lifeline's interrupt on to the server, whatever stage it is at.
    expect(calls[0]).toContain('--init');
    const line = calls.findIndex((args) => args[0] === 'exec' && args.includes('sh'));
    expect(line, 'the lifeline begins as soon as the container runs').toBe(1);
    expect(calls[line]?.slice(0, 5)).toEqual(['exec', '-i', name, 'sh', '-c']);
    const marker = /^touch (\S+); cat > \/dev\/null; kill -TERM 1$/u.exec(
      calls[line]?.[5] ?? '',
    )?.[1];
    // Until the line checks in, the container stops itself: a drill killed before it began.
    expect(calls[0]?.at(-1)).toMatch(/& sleep 15; \[ -e (\S+) \] && wait$/u);
    expect(calls[0]?.at(-1)).toContain(`[ -e ${marker ?? 'no marker'} ]`);
    // Its own process group, so a signal to the drill's group leaves it to close the line.
    expect(options).toEqual({ detached: true });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(ended, 'the line ends only once the removal was asked').toEqual([calls.length]);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(['rm', '-f', '-v']);
  });
});
