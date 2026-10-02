// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's content beyond its fields: comments and their thread, time entries
// and tags. Re-exported whole by the package index (`../index.ts`), which keeps
// the rest of the package's way in.

export {
  COMMENT_TYPE_KEY,
  externalCommentProjection,
  writeComment,
  type CommentAudience,
  type CommentType,
  type StoredComment,
} from './comments.ts';
export {
  commentSignals,
  lockComment,
  readTaskComments,
  removeComment,
  rewriteComment,
  type CommentSignal,
} from './comment-thread.ts';
export {
  deleteTimeEntry,
  logTime,
  parseDuration,
  readTaskTime,
  setTimeEntryNote,
  startTimer,
  stopTimer,
  type TaskTime,
  type TimeEntry,
} from './time.ts';
export {
  addTaskTag,
  createTag,
  listTags,
  removeTaskTag,
  TAG_NAME_LIMIT,
  tagNameOf,
  tagsOfTask,
  type Tag,
} from './tags.ts';
