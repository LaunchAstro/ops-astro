// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, design R9 and F4: no handler sees an agent's content, inherited
// or explicit. Each case runs in a fresh process (`agent-hook-case.ts`) with
// the tracing flags unset: a content recorder planted through a
// context-variable hook, then through an environment-variable hook with its
// own flag, each on a direct `invoke` and through a binding with empty
// options; a model built or bound with callbacks, or built with core's
// `callbackManager` alias; an `invoke` with callbacks or verbose output; the
// model's own `callbacks` set after it is built, after it is bound, or by a
// subclass before it is built, and its own `verbose` set after (#1921); a
// value that reads one way to the guard and another to core: the model's
// `verbose` as a getter, a callback manager whose handlers are a getter, an
// empty list with its own `map`, an empty list behind a proxy, a message
// whose content getter fills the checked list, a message getter that plants
// a hook after the guard (#1925); and the runner with a
// hook planted. Each is refused
// `TRACING_NOT_ALLOWED` before any callback, with nothing sent, or runs
// isolated with the hook never called. Values core never reads are not
// refused but never reach a handler: a `generate` whose options read empty
// first and a recorder after (read once), and the model's own `callbacks` or
// `verbose` set by a getter core would run after the guard (core runs a
// model of its own), and a message whose own type accessor would plant a hook
// at core's last read (core reads a rebuilt copy), and a `metadata` or
// `configurable` getter, or an inherited callback manager's metadata getter,
// that would plant one (core is handed plain copies of `stop` and `tools`
// only, and no callbacks). The cases print booleans and counts,
// so the planted marker is never printed.
//
// LangSmith makes no network call: a real listener stands in for its
// endpoint, with a key set. A clean run sends it nothing, and a run with
// tracing on is refused and sends it nothing.
//
// Controls: the same hook, on a plain model outside the agent, does see the
// marker, and the same tracing settings outside the agent do reach the
// listener, so the recorder and the listener are live.

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface CaseResult {
  readonly result: string;
  readonly seen: number;
  readonly marked: boolean;
  readonly sent: number;
  readonly ended: readonly string[];
}

let hits = 0;
const listener = createServer((request, response) => {
  hits += 1;
  request.resume();
  response.end('{}');
});
let endpoint = '';

beforeAll(async () => {
  await new Promise<void>((listening) => {
    listener.listen(0, '127.0.0.1', listening);
  });
  endpoint = `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`;
});
afterAll(() => {
  listener.close();
});

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(LANGSMITH|LANGCHAIN)_/u.test(name)),
);

async function inFreshProcess(
  kind: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<CaseResult & { readonly leaked: boolean; readonly hits: number }> {
  hits = 0;
  const env = {
    ...CLEAN_ENV,
    LANGSMITH_ENDPOINT: endpoint,
    LANGSMITH_API_KEY: 'lsv2_planted',
    ...extra,
  };
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      ['tests/runs/agent-hook-case.ts', kind],
      { env },
      (_error, out, err) => {
        done({ stdout: out, stderr: err });
      },
    );
  });
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  const leaked = /OA-MARKER-/u.test(stdout) || /OA-MARKER-/u.test(stderr);
  return { ...(JSON.parse(line) as CaseResult), leaked, hits };
}

const REFUSED = ['context-direct', 'context-bound', 'env-direct', 'env-bound'];
const OPTIONS = [
  'none-constructed-with-callbacks',
  'none-bound-with-callbacks',
  'none-invoke-verbose',
  'none-invoke-callbacks',
  'none-constructed-with-callback-manager',
  'none-own-callbacks-set-after-construction',
  'none-own-callbacks-set-after-binding',
  'none-own-callbacks-set-before-construction',
  'none-own-verbose-set-after-construction',
  'none-own-verbose-read-late',
  'none-generate-manager-handlers-read-late',
  'none-invoke-empty-list-with-its-own-map',
  'none-generate-empty-list-behind-a-proxy',
  'none-generate-message-getter-fills-the-list-after-the-guard',
  'none-generate-message-type-getter-plants-a-hook',
];
const UNREAD = [
  'none-generate-callbacks-read-late',
  'none-own-cache-getter-sets-callbacks-after-the-guard',
  'none-own-cache-getter-sets-verbose-after-the-guard',
  'none-generate-message-type-getter-plants-a-hook-at-cores-last-read',
  'none-invoke-metadata-getter-plants-a-hook',
  'none-invoke-configurable-getter-plants-a-hook',
  'none-inherited-manager-metadata-getter-plants-a-hook',
];

// oxlint-disable-next-line max-lines-per-function -- one listener, every route a handler takes
describe('an inherited hook or tracer never sees an agent model content', () => {
  it.each(REFUSED)('a planted hook on %s is refused before any callback', async (kind) => {
    const run = await inFreshProcess(kind);
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, marked: false, sent: 0 });
    expect(run.leaked).toBe(false);
  });

  it.each(OPTIONS)('%s is refused before any callback', async (kind) => {
    const run = await inFreshProcess(kind);
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, marked: false, sent: 0 });
    expect(run.leaked).toBe(false);
  });

  it.each(UNREAD)('%s: core never reads it, so the recorder never sees content', async (kind) => {
    const run = await inFreshProcess(kind);
    expect(run).toMatchObject({ seen: 0, marked: false });
    expect(run.leaked).toBe(false);
  });

  it('the runner with a hook planted refuses and records the stop, with nothing sent', async () => {
    const run = await inFreshProcess('context-runner');
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, sent: 0 });
    expect(run.ended).toEqual(['TRACING_NOT_ALLOWED']);
  });

  it('the runner in a fresh store runs isolated: the hook is never called', async () => {
    const run = await inFreshProcess('env-runner-isolated');
    expect(run).toMatchObject({ result: 'ran', seen: 0, marked: false, sent: 2 });
  });

  it('control: the same hook on a plain model outside the agent sees the marker', async () => {
    const run = await inFreshProcess('context-control-outside-the-agent');
    expect(run.seen).toBeGreaterThan(0);
    expect(run.marked).toBe(true);
    expect(run.leaked, 'booleans only, even when seen').toBe(false);
  });

  it('LangSmith: a clean run sends its endpoint nothing, and succeeds', async () => {
    const run = await inFreshProcess('none-clean-run');
    expect(run).toMatchObject({ result: 'ran', sent: 2 });
    expect(run.hits).toBe(0);
  });

  it('LangSmith: a run with tracing on is refused and sends its endpoint nothing', async () => {
    const run = await inFreshProcess('tracing-runner', { LANGSMITH_TRACING: 'true' });
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', sent: 0 });
    expect(run.hits).toBe(0);
  });

  it('control: tracing on outside the agent does reach the listener', async () => {
    const run = await inFreshProcess('tracing-control-outside-the-agent', {
      LANGSMITH_TRACING: 'true',
    });
    expect(run.hits).toBeGreaterThan(0);
  });
});
