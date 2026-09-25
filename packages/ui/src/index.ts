// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared interface package's one entry point, and the surface a code-side
// discovery check reads.
//
// It is `export *` per module rather than a hand-written list, so a component
// added to a module below appears here without anybody remembering to add it —
// which is the whole reason the capability map's missing-registration check can
// be trusted in the code-to-map direction.
//
// **The naming rule this package lives under, because the check depends on it:
// an export in PascalCase is a UI component and must carry a capability-map
// entry; everything else is camelCase or UPPER_CASE and must not.** It is a
// convention, and it is checkable from the built artefact, which is more than
// can be said for a comment asserting the same thing.
//
// This package imports no `core-*` package and must not. It owns visual
// controls and layout; session-scoped panel registration, open state and drafts
// belong to `apps/web` [ui-reference CONTRACT.md:305].
//
// **What the working slice carries and what it leaves in the draft.** The draft
// at `ops-astro-t1-draft@60f2009` also exports `AgentTab`, `AgentPanel` and
// `Gate`. All three draw surfaces the slice's three screens do not reach and
// whose records no part of this build stores, so they are not ported: an
// exported component that nothing mounts is an estate to maintain, not a
// capability. They stay in the draft until the phase that owns them lands.

export * from './state/corpus.ts';
export * from './state/project.ts';
export * from './primitives/Absence.tsx';
export * from './primitives/Status.tsx';
export * from './primitives/Tabs.tsx';
export * from './surfaces/Shell.tsx';
export * from './surfaces/Board.tsx';
export * from './surfaces/TaskPage.tsx';
