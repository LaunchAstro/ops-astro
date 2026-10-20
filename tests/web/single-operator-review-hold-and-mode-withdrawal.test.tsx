// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await, max-lines-per-function -- Sol's proofs kept as written: async stand-in fetches, one world. */
//
// Sol's proofs on #2201 (round 1, S2201-1 to S2201-3), assertions unchanged:
// the missing-review hold on Launch outlives a page-check reread and a failed
// follow-up read of the same version, and a settings denial withdraws the mode
// it had shown; a late mode answer stays inside its business and person.
import { act, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useCorrections } from '../../apps/web/src/assistant/use-corrections.ts';
import { useSingleOperatorMode } from '../../apps/web/src/assistant/single-operator.ts';
import { CorrectionCard } from '../../apps/web/src/views/correction-card.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const denied = (): Response =>
  json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
const versionId = '11111111-1111-4111-8111-111111111111';
const ask = { page: 'About', word: 'old', replacement: 'new' };

afterEach(() => vi.useRealTimers());

function heldWorld(readFails = false) {
  let refused = false;
  let reads = 0;
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith('/live_correction/list')) return json({ ok: true, corrections: [] });
    if (path.endsWith('/live_correction/decide')) {
      refused = true;
      return json(
        { refused: true, code: 'ASTRA_REVIEW_MISSING', names: ['versionId'], fixes: [] },
        409,
      );
    }
    if (path.endsWith('/live_correction/read')) {
      reads += 1;
      if (readFails && refused) return json({}, 503);
      return json({
        ok: true,
        correction: {
          correctionId: 'c-1',
          state: 'requested',
          approver: null,
          versionId,
          verifiedAt: '2026-10-20T00:00:00.000Z',
          verifiedForMs: 60_000,
          refusal: null,
        },
      });
    }
    throw new Error(`Unexpected call ${path}`);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  function View(): ReactElement {
    const corrections = useCorrections(
      client,
      async () => ({ ok: true, correctionId: 'c-1' }),
      'alpha:ada',
    );
    return (
      <>
        <button data-ask onClick={() => corrections.request?.(ask)}>
          Ask
        </button>
        {corrections.list.map((correction) => (
          <CorrectionCard
            key={correction.correctionId}
            correction={correction}
            busy={corrections.busy}
            singleOperator
            onDecide={(decision) => corrections.decide(correction.correctionId, decision)}
            onReread={() => corrections.reread(correction.correctionId)}
            onReceipts={() => corrections.openReceipts(correction.correctionId)}
          />
        ))}
      </>
    );
  }
  return { View, paths, reads: () => reads };
}

it('a page-check refresh cannot release the missing-review hold', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  const world = heldWorld();
  const page = await mount(<world.View />);
  await page.click('[data-ask]');
  await page.click('[data-correction-decide="approve"]');
  expect((page.find('[data-correction-decide="approve"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(page.find('[data-correction-launch-held]')?.textContent).toMatch(/Astra.*review/u);
  const before = world.reads();
  // The ordinary page-check clock expires; its read reports the same version and no review facts.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_001);
  });
  await settle();
  expect(world.reads()).toBeGreaterThan(before);
  expect(world.paths.some((path) => path.includes('record_review'))).toBe(false);
  expect((page.find('[data-correction-decide="approve"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(page.find('[data-correction-launch-held]')?.textContent).toMatch(/Astra.*review/u);
});

it('a failed follow-up read cannot discard the missing-review refusal', async () => {
  const world = heldWorld(true);
  const page = await mount(<world.View />);
  await page.click('[data-ask]');
  await page.click('[data-correction-decide="approve"]');
  await settle();
  expect(world.reads()).toBe(2);
  expect((page.find('[data-correction-decide="approve"]') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(page.find('[data-correction-launch-held]')?.textContent).toMatch(/Astra.*review/u);
});

function Mode(props: { client: OperationsClient; grant: string; wanted: boolean }): ReactElement {
  const mode = useSingleOperatorMode(props.client, props.grant, props.wanted);
  return <output>{mode === null ? 'unknown' : mode ? 'on' : 'off'}</output>;
}

it('a new settings denial withdraws the previously readable mode', async () => {
  let readable = true;
  let reads = 0;
  const fetch: typeof globalThis.fetch = async () => {
    reads += 1;
    return readable
      ? json({ ok: true, settings: [{ key: 'single_operator_mode', value: true }] })
      : denied();
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<Mode client={client} grant="alpha:ada" wanted />);
  expect(page.text()).toBe('on');
  await page.render(<Mode client={client} grant="alpha:ada" wanted={false} />);
  readable = false;
  await page.render(<Mode client={client} grant="alpha:ada" wanted />);
  await settle();
  expect(reads).toBe(2);
  expect(page.text()).toBe('unknown');
});

it('a late mode response stays inside its business and person', async () => {
  let release: ((response: Response) => void) | undefined;
  const late = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const alpha = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async () => late,
  });
  const bravo = new OperationsClient({
    origin: '',
    businessKey: 'bravo',
    signedIn: true,
    fetch: async () => denied(),
  });
  const page = await mount(<Mode client={alpha} grant="alpha:ada" wanted />);
  await page.render(<Mode client={bravo} grant="bravo:ada" wanted />);
  await act(async () => {
    release?.(json({ ok: true, settings: [{ key: 'single_operator_mode', value: true }] }));
  });
  expect(page.text()).toBe('unknown');
  await page.render(<Mode client={bravo} grant="bravo:bo" wanted />);
  expect(page.text()).toBe('unknown');
});
