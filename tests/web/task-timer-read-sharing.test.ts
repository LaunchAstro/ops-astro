// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { task } from './task-page-stub.tsx';

const noRelease = (_answer: Response): void => {};
const ID = '11111111-1111-4111-8111-111111111111';
const START = '2026-10-09T01:00:00.000Z';
const ref = { id: ID, key: 'Timer-A', title: 'Alpha work' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const started = () =>
  json({ recordId: null, revision: null, detail: { entryId: 'entry-a', startedAt: START } });
const found = (entryId: string | null) =>
  json({
    ok: true,
    task: task({
      ...ref,
      time: {
        entries: [],
        totalMinutes: 0,
        running: entryId === null ? null : { entryId, startedAt: START },
      },
    }),
  });
const denied = () => json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
const flush = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};
function controller(fetch: typeof globalThis.fetch) {
  return new TaskTimer(
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    () => true,
  );
}

for (const latestFirst of [false, true]) {
  it(`concurrent authorised key and UUID readers retain both answers, latest first ${latestFirst}`, async () => {
    const releases: ((answer: Response) => void)[] = [];
    const timer = controller(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const page = timer.read('Timer-A', () => true);
    const panel = timer.read(ID, () => true);
    releases[latestFirst ? 1 : 0]?.(found('entry-a'));
    await flush();
    releases[latestFirst ? 0 : 1]?.(found('entry-a'));
    await flush();
    expect(await page).toHaveProperty('ok', true);
    expect(await panel).toHaveProperty('ok', true);
    expect(timer.snapshot().binding?.task).toEqual(ref);
  });
}

for (const deniedKey of ['Timer-A', ID]) {
  it(`a newer ${deniedKey} denial rejects an older authorised projection even without a known binding`, async () => {
    const releases: ((answer: Response) => void)[] = [];
    const timer = controller(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const older = timer.read(deniedKey === ID ? 'Timer-A' : ID, () => true);
    const newer = timer.read(deniedKey, () => true);
    releases[1]?.(denied());
    const deniedAnswer = await newer;
    releases[0]?.(found('entry-a'));
    expect(deniedAnswer).toHaveProperty('refused', true);
    expect(await older).toHaveProperty('unavailable', true);
    expect(await older).not.toHaveProperty('ok');
    expect(timer.snapshot().binding).toBeNull();
    const fresh = timer.read('Timer-A', () => true);
    releases[2]?.(found('entry-a'));
    await fresh;
    expect(timer.snapshot().binding?.task).toEqual(ref);
  });
}

for (const unavailable of [false, true]) {
  it(`an older authorised reader waits for a newer pending ${unavailable ? 'unavailable answer' : 'denial'}`, async () => {
    const releases: ((answer: Response) => void)[] = [];
    const timer = controller(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    let published = false;
    const older = timer
      .read('Timer-A', () => true)
      .then((result) => {
        published = true;
        return result;
      });
    const newer = timer.read(ID, () => true);
    releases[0]?.(found('entry-a'));
    await flush();
    expect(published).toBe(false);
    releases[1]?.(unavailable ? json({}, 503) : denied());
    const blocked = await newer;
    expect(await older).toEqual(blocked);
    expect(await older).not.toHaveProperty('ok');
    expect(timer.snapshot().binding).toBeNull();
  });
}

for (const withheld of [false, true]) {
  it(`a superseded authorised observer receives the newer ${withheld ? 'withheld time' : 'running entry'} projection`, async () => {
    const releases: ((answer: Response) => void)[] = [];
    const timer = controller(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const older = timer.read('Timer-A', () => true);
    const newer = timer.read(ID, () => true);
    releases[1]?.(
      withheld ? json({ ok: true, task: task({ ...ref, time: null }) }) : found('entry-new'),
    );
    const newest = await newer;
    releases[0]?.(found('entry-old'));
    expect(await older).toEqual(newest);
    expect(timer.snapshot().binding?.running?.entryId ?? null).toBe(withheld ? null : 'entry-new');
  });
}

it('a still-current observer applies a joined denial even after the newer reader unmounts', async () => {
  const releases: ((answer: Response) => void)[] = [];
  const timer = controller((url) =>
    String(url).endsWith('/start')
      ? Promise.resolve(started())
      : new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
  );
  timer.start(ref);
  await flush();
  let mounted = true;
  const older = timer.read('Timer-A', () => true);
  const newer = timer.read(ID, () => mounted);
  mounted = false;
  releases[1]?.(denied());
  await newer;
  releases[0]?.(found('entry-a'));
  await older;
  expect(timer.snapshot().binding?.task).toEqual({ id: ID });
  expect(timer.snapshot().binding?.running?.entryId).toBe('entry-a');
  expect(releases).toHaveLength(2);
});

function retainedAnswers(timer: TaskTimer): number {
  const floors: unknown = Reflect.get(timer, 'readFloors');
  if (!(floors instanceof Map)) throw new Error('Expected the existing private read owner');
  return [...new Set(floors.values())].filter(
    (flight: unknown) =>
      typeof flight === 'object' && flight !== null && Reflect.get(flight, 'answer') !== null,
  ).length;
}

it('a never-settling unrelated read cannot retain completed rich task response promises', async () => {
  let release = noRelease;
  const otherId = '22222222-2222-4222-8222-222222222222';
  const other = () => json({ ok: true, task: task({ id: otherId, key: 'Timer-B', time: null }) });
  const timer = controller((_url, init) =>
    (JSON.parse(String(init?.body)) as Record<string, unknown>)['recordId'] === otherId
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(found('entry-a')),
  );
  const pending = timer.read(otherId, () => true);
  try {
    await timer.read('Timer-A', () => true);
    await timer.read(ID, () => true);
    expect(retainedAnswers(timer)).toBe(1);
  } finally {
    release(other());
    await pending;
  }
  expect(retainedAnswers(timer)).toBe(0);
});

it('retired completed denial still fences an older answer that discovers its UUID alias late', async () => {
  const releases: ((answer: Response) => void)[] = [];
  const timer = controller(
    () =>
      new Promise<Response>((resolve) => {
        releases.push(resolve);
      }),
  );
  const older = timer.read('Timer-A', () => true);
  const newer = timer.read(ID, () => true);
  releases[1]?.(denied());
  await newer;
  expect(retainedAnswers(timer)).toBe(1);
  releases[0]?.(found('entry-a'));
  expect(await older).not.toHaveProperty('ok');
  expect(timer.snapshot().binding).toBeNull();
  expect(retainedAnswers(timer)).toBe(0);
});
