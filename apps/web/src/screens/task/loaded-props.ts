// SPDX-License-Identifier: AGPL-3.0-only
// The loaded owning-task contract and its draft custody types, shared by the
// page and its Agent side. Types only; rendering and writes remain on the page.
import type { OperationsClient } from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TaskStateView,
} from '../../../../../packages/core-wire/src/index.ts';
import type { DecisionNote } from '../../views/proposals.tsx';
import type { ProposeDraft, TopUpNote } from '../../views/propose-form.tsx';
import type { PanelOpener, Perspective } from './Perspectives.tsx';
import type { CommentDraft } from './Comments.tsx';
import type { RowEdit } from './Thread.tsx';

/** Where an unsaved edit began: the revision, and the values as they stood. */
export interface DraftBase {
  readonly revision: number;
  readonly title: string;
  readonly due: string;
  /** The task as the edit began: what changed since is told against it. */
  readonly task: Task;
}

/** An unsaved title and due date, and everything needed to settle it safely. */
export interface Draft {
  /** Capability and task together: a draft belongs to one task under one grant. */
  readonly identity: string;
  /**
   * Bumped by every keystroke. A save settles the generation it submitted and
   * no other, so a response that arrives after further typing clears nothing.
   */
  readonly generation: number;
  readonly base: DraftBase;
  readonly title: string;
  readonly due: string;
  /** A save whose outcome is unknown: its `operationId` and the generation it sent. */
  readonly attempt: SaveAttempt | null;
}

export interface SaveAttempt {
  readonly operationId: string;
  readonly generation: number;
}

export interface LoadedProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  /** Stable owning answer: local view changes do not start another execution read. */
  readonly taskRead: Task;
  /** The business's task states `task.read` sent, the Status select's choices. */
  readonly states: readonly TaskStateView[];
  /** The unsaved edit, or nothing. Its presence is what "dirty" means. */
  readonly draft: Draft | null;
  /** What the server said about the last decision, or nothing. */
  readonly note: DecisionNote | null;
  readonly onDecided: (note: DecisionNote | null) => void;
  /** This reader's refused comment, held above the read so a reread keeps it. */
  readonly commentRefusal: string | null;
  readonly onCommentRefused: (because: string) => void;
  /** This reader's refused proposal, held the same way. */
  readonly proposeRefusal: string | null;
  readonly onProposeRefused: (because: string) => void;
  /** The last stale lifecycle or assignee press, quoted across its reread. */
  readonly moved: string | null;
  readonly onMoved: (because: string | null) => void;
  /** The unsent comment and proposal, held so a reread keeps what was typed. */
  readonly commentDraft: CommentDraft | null;
  readonly onCommentDraft: (next: CommentDraft | null) => void;
  /** The edit open on one of the reader's comments, held so a stale reread keeps it. */
  readonly commentEdit: RowEdit | null;
  readonly onCommentEdit: (next: RowEdit | null) => void;
  readonly proposeDraft: ProposeDraft | null;
  readonly onProposeDraft: (next: ProposeDraft | null) => void;
  /** The last top-up's answer, held so a reread keeps it (T2e). */
  readonly topUpNote: TopUpNote | null;
  readonly onTopUpNote: (note: TopUpNote | null) => void;
  /** Which side of the task this reading shows, held above the read (MP-4-3). */
  readonly perspective: Perspective;
  readonly onPerspective: (next: Perspective) => void;
  /** Whether the finished subtasks are unfolded, held above the read (MP-4-4). */
  readonly showFinished: boolean | null;
  readonly onShowFinished: (next: boolean | null) => void;
  /** The subtask add box's unsent name, held above the read so a reread keeps it. */
  readonly stepTitle: string | null;
  readonly onStepTitle: (next: string | null) => void;
  /** Whether every time entry shows, not only the latest three, held above the read (MP-4-6). */
  readonly showAllTime: boolean;
  readonly onShowAllTime: (next: boolean) => void;
  readonly onOpenPanel: PanelOpener | undefined;
  readonly onOpenTask?: ((key: string, origin?: HTMLElement) => void) | undefined;
  /** Record, or forget, the draft save whose outcome is unknown. */
  readonly onAttempt: (attempt: SaveAttempt | null) => void;
  readonly onDraft: (next: { title: string; due: string } | null, base: DraftBase) => void;
  readonly onSaved: (generation: number) => void;
  readonly onDiscard: () => void;
  readonly onChanged: () => void;
  readonly onStepUp: (open: true | null) => void;
}
