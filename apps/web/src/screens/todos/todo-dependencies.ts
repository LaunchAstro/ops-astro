// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useState } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { useTaskDependencies, type DependencyAdmission } from '../../data/board-live.ts';
import { type scopedBody, type useTodoVocabulary } from './typed-scope.ts';

export type TodoDependency = (admission: DependencyAdmission) => void;
interface ReadIdentity {
  readonly body: string;
  readonly intent: string;
  readonly client: OperationsClient;
  readonly version: number;
}
type AdmissionReport = ReadIdentity & { readonly admission: DependencyAdmission };
function sameRead(a: ReadIdentity, b: ReadIdentity): boolean {
  return (
    a.body === b.body && a.intent === b.intent && a.client === b.client && a.version === b.version
  );
}
function useAdmissionReport(identity: ReadIdentity, current: { readonly current: ReadIdentity }) {
  const [reported, setReported] = useState<AdmissionReport | null>(null);
  const { body, intent, client, version } = identity;
  const onDependency = useCallback<TodoDependency>(
    (admission) => {
      const read = { body, intent, client, version };
      if (!sameRead(current.current, read)) return;
      setReported((before) =>
        before !== null && sameRead(before, read) && before.admission === admission
          ? before
          : { ...read, admission },
      );
    },
    [body, intent, client, version, current],
  );
  return { reported, onDependency };
}
/** The existing view owner retains admission while its vocabulary temporarily withdraws rows. */
export function useTodoDependencies(
  props: { readonly client: OperationsClient; readonly grantKey: string },
  read: ReturnType<typeof scopedBody>,
  vocabulary: ReturnType<typeof useTodoVocabulary>,
  intent: string,
): TodoDependency {
  const body = JSON.stringify(read.body);
  const version = vocabulary.version;
  const current = useRef({ body, intent, client: props.client, version, withdrawn: true });
  const { reported, onDependency } = useAdmissionReport(
    { body, intent, client: props.client, version },
    current,
  );
  // Permission loading can temporarily erase resolved chips. The requested view has not changed.
  const prior =
    reported?.client === props.client &&
    (reported.intent === intent || (!vocabulary.recovering && reported.body === body))
      ? reported.admission
      : 'withdrawn';
  const admission =
    prior === 'withdrawn' ||
    vocabulary.withdrawn ||
    (read.blocked && !vocabulary.recovering) ||
    (reported?.body !== body && !vocabulary.recovering)
      ? 'withdrawn'
      : vocabulary.recovering
        ? 'recovering'
        : prior;
  current.current = {
    body,
    intent,
    client: props.client,
    version,
    withdrawn: admission === 'withdrawn',
  };
  useTaskDependencies(
    props.client,
    props.grantKey,
    () => {
      if (current.current.withdrawn) return;
      vocabulary.refresh();
    },
    admission,
  );
  return onDependency;
}
