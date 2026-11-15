-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Docs piece 4a (#2514, round DECISIONS 129): a folder is renamed or moved inside its business,
-- and a page moves between folders.
--
-- The commands are `docs.rename_folder`, `docs.move_folder` and `docs.update_page` with a
-- `folderId` (`packages/core-records/src/docs/folders.ts` and `store.ts`), each `docs:write` on
-- the business.
--
-- **A folder moves only under a folder of its own business that is not itself or one of its own
-- subfolders.** 20261115002300's tenant-pair parent key still keeps the parent in the business,
-- and its check still refuses a folder as its own parent. The deeper rule is the store's: a move
-- locks every folder row of the business in id order before it reads the tree, so two crossing
-- moves wait on each other and the second sees the first, never a cycle. One name per parent,
-- whatever its case, stays the unique index's rule, for a rename and a move as for a create.
--
-- A page's move is a write like any other: it names the version it read and appends a version row.
-- No folder or page is deleted here.

grant update (name, parent_id) on public.docs_folders to ops_astro_app;
grant update (folder_id) on public.docs_pages to ops_astro_app;
