// SPDX-License-Identifier: AGPL-3.0-only
import { use, useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { Select } from '@launchastro/ui';
import type {
  InternalTaskDetail,
  TaskScores,
} from '../../../../../packages/core-wire/src/index.ts';
import { HeldScores } from './scores-custody-context.tsx';
import type { ScoresCustody, ScoreHold } from './scores-custody.ts';
import { isScoreValue, type ScoreMark } from './scores-slot.ts';

interface Props {
  readonly task: InternalTaskDetail;
  readonly scope: 'page' | 'panel';
  readonly disabled?: boolean;
  readonly onChanged: () => void;
}
const MARKS: readonly { readonly key: ScoreMark; readonly label: string }[] = [
  { key: 'impact', label: 'Impact' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'ease', label: 'Ease' },
];
const CHOICES = [
  { value: '', label: 'Not set' },
  ...Array.from({ length: 10 }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  })),
];
function useScoreState(custody: ScoresCustody, id: string, onChanged: () => void) {
  const hold = useSyncExternalStore(
    custody.subscribe,
    () => custody.snapshot(id),
    () => custody.snapshot(id),
  );
  const seen = useRef(hold.changed);
  useEffect(() => {
    if (seen.current === hold.changed) return;
    seen.current = hold.changed;
    onChanged();
  }, [hold.changed, onChanged]);
  return hold;
}
interface RecoveryProps {
  readonly hold: ScoreHold;
  readonly custody: ScoresCustody;
  readonly id: string;
}
function ScoreRecovery(props: RecoveryProps): ReactElement {
  const { hold, custody, id } = props;
  return (
    <>
      {hold.failure === null ? null : (
        <p className="field__error" role="alert">
          {hold.failure.because}
        </p>
      )}
      {hold.uncertain ? (
        <p role="status">
          This score change may already have been stored. Retry the same change to reconcile it.
        </p>
      ) : null}
      {hold.ephemeral ? (
        <p role="status">Memory-only score recovery. Reloading this tab loses this attempt.</p>
      ) : null}
      {!hold.kept && !hold.ephemeral ? (
        <p role="alert">
          {hold.pending === null
            ? 'The stored answer is confirmed, but this tab could not clear recovery. No further score change was sent.'
            : hold.uncertain
              ? 'This tab could not keep score recovery. No retry was sent.'
              : 'This tab could not keep score recovery. No score change was sent.'}
        </p>
      ) : null}
      {hold.pending !== null || (!hold.kept && !hold.ephemeral) ? (
        <button
          type="button"
          className="btn"
          data-score-retry
          disabled={hold.busy}
          onClick={() => custody.retry(id)}
        >
          {hold.pending === null ? 'Retry score recovery cleanup' : 'Retry score change'}
        </button>
      ) : null}
      {hold.pending !== null && !hold.kept && !hold.uncertain && !hold.ephemeral ? (
        <button
          type="button"
          className="btn"
          disabled={hold.busy}
          onClick={() => custody.sendEphemeral(id)}
        >
          Send without reload recovery
        </button>
      ) : null}
    </>
  );
}
function ScoreEditor(
  props: Props & { readonly custody: ScoresCustody; readonly scores: TaskScores },
): ReactElement {
  const hold = useScoreState(props.custody, props.task.id, props.onChanged);
  const disabled =
    props.disabled === true ||
    hold.busy ||
    hold.pending !== null ||
    (!hold.kept && !hold.ephemeral) ||
    hold.failure?.kind === 'closed';
  const choose = (mark: ScoreMark, text: string): void => {
    const value = text === '' ? null : Number(text);
    if (disabled || !isScoreValue(value) || value === props.scores[mark]) return;
    props.custody.choose(props.task.id, props.task.revision, mark, value);
  };
  return (
    <>
      {MARKS.map(({ key, label }) => (
        <div key={key} id={`${props.scope}-score-${key}`}>
          <Select
            label={label}
            value={props.scores[key] === null ? '' : String(props.scores[key])}
            disabled={disabled}
            options={CHOICES}
            onChange={(value) => choose(key, value)}
          />
        </div>
      ))}
      <ScoreRecovery hold={hold} custody={props.custody} id={props.task.id} />
      {hold.failure?.kind === 'stale' && hold.pending === null ? (
        <button type="button" className="btn" onClick={props.onChanged}>
          Read current marks
        </button>
      ) : null}
    </>
  );
}
/** Only an admitted internal read provides marks. Page and panel share its frame owner. */
export function ScoreFields(props: Props): ReactElement | null {
  const custody = use(HeldScores);
  return custody === null || props.task.scores === undefined || !('client' in props.task) ? null : (
    <ScoreEditor key={props.task.id} {...props} scores={props.task.scores} custody={custody} />
  );
}
