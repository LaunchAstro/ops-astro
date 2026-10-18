// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, design R9 and F4: no handler sees an agent's content, inherited
// or explicit. Each case runs in a fresh process (`agent-hook-case.ts`) with
// the tracing flags unset: a content recorder planted through a
// context-variable hook, then through an environment-variable hook with its
// own flag, each on a direct `invoke` and through a binding with empty
// options; a model built or bound with callbacks; an `invoke` with callbacks
// or verbose output; and the runner with a hook planted. Each is refused
// `TRACING_NOT_ALLOWED` before any callback, with nothing sent, or runs
// isolated with the hook never called. The cases print booleans and counts,
// so the planted marker is never printed.
//
// LangSmith makes no network call: a real listener stands in for its
// endpoint, with a key set. A clean run sends it nothing, and a run with
// tracing on is refused and sends it nothing.
//
// Controls: the same hook, on a plain model outside the agent, does see the
// marker, and the same tracing settings outside the agent do reach the
// listener, so the recorder and the listener are live.
//
// #1904 P15 adds the definition: the marker planted in the attempt's pinned
// file, its system message (`agent-definition-hook-case.ts`). A planted hook
// or tracing is refused before any callback, and an isolated run hands the
// marker to the broker port, the way to the provider, with the hook never
// called.

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
  readonly delivered?: boolean;
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
  script = 'tests/runs/agent-hook-case.ts',
): Promise<CaseResult & { readonly leaked: boolean; readonly hits: number }> {
  hits = 0;
  const env = {
    ...CLEAN_ENV,
    LANGSMITH_ENDPOINT: endpoint,
    LANGSMITH_API_KEY: 'lsv2_planted',
    ...extra,
  };
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, [script, kind], { env }, (_error, out, err) => {
      done({ stdout: out, stderr: err });
    });
  });
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  const leaked = /OA-MARKER-/u.test(stdout) || /OA-MARKER-/u.test(stderr);
  return { ...(JSON.parse(line) as CaseResult), leaked, hits };
}

const DEFINITION_CASE = 'tests/runs/agent-definition-hook-case.ts';

const REFUSED = ['context-direct', 'context-bound', 'env-direct', 'env-bound'];
const OPTIONS = [
  'none-constructed-with-callbacks',
  'none-bound-with-callbacks',
  'none-invoke-verbose',
  'none-invoke-callbacks',
];

describe('an inherited hook or tracer never sees an agent model content', () => {
  it.each(REFUSED)('a planted hook on %s is refused before any callback', async (kind) => {
    const run = await inFreshProcess(kind);
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, marked: false, sent: 0 });
    expect(run.leaked).toBe(false);
  });

  it.each(OPTIONS)('%s is refused before any callback', async (kind) => {
    const run = await inFreshProcess(kind);
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, marked: false, sent: 0 });
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

describe("a run's definition never reaches an inherited hook or tracer", () => {
  it("a run's definition with a hook planted is refused before any callback", async () => {
    // Mutation: the system message built before the run's refusal, inside a hooked store -> seen, red.
    const run = await inFreshProcess('definition-context-runner', {}, DEFINITION_CASE);
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', seen: 0, marked: false, sent: 0 });
    expect(run).toMatchObject({ delivered: false, leaked: false });
  });

  it("a run's definition in a fresh store reaches the broker port, never the hook", async () => {
    // Mutation: the run's store not isolated -> the hook sees the definition, red.
    const run = await inFreshProcess('definition-env-runner-isolated', {}, DEFINITION_CASE);
    expect(run).toMatchObject({ result: 'ran', seen: 0, marked: false, sent: 2, delivered: true });
    expect(run.leaked).toBe(false);
  });

  it("LangSmith: a run's definition with tracing on is refused and sends its endpoint nothing", async () => {
    // Mutation: the runner skips `runRefused` when it has a definition -> sent and traced, red.
    const run = await inFreshProcess(
      'definition-tracing-runner',
      { LANGSMITH_TRACING: 'true' },
      DEFINITION_CASE,
    );
    expect(run).toMatchObject({ result: 'TRACING_NOT_ALLOWED', sent: 0, leaked: false });
    expect(run.hits).toBe(0);
  });
});
