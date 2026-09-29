// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: who the assistant talks about, and which models it may offer
// (declared shape; decided in the next commit).

import type { AssistantModel, AssistantOffer } from '@launchastro/ui';
import type { RouteId } from '../routes.ts';

export type ModelChoice = AssistantModel;

export interface ScopeInput {
  readonly route: RouteId;
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly clientId: string | null;
  } | null;
}

export interface Subject {
  readonly kind: 'page' | 'client' | 'task';
  readonly route: RouteId;
  readonly label: string;
  readonly placeholder: string;
  readonly chips: readonly string[];
  readonly clientId: string | null;
}

export const LOCAL_MODEL_WAIT = '';

export function subjectFor(input: ScopeInput): Subject {
  return {
    kind: 'page',
    route: input.route,
    label: '',
    placeholder: '',
    chips: [],
    clientId: null,
  };
}

export function modelOffer(
  _subject: Subject,
  _catalogue: readonly ModelChoice[],
  _clientModelUse: boolean | null,
): AssistantOffer {
  return { models: [], waiting: null };
}
