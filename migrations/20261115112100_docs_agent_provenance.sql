-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Docs, the agent path (#2519, #2493 piece 3): a folder or page version an agent writes names
-- the task it worked under and the delegation it held, as a review row names its delegation
-- (20261028140000). A person's write names neither.
--
-- Both are tenant pairs, so a task or delegation of another business cannot be named, and they
-- are named together or not at all. No custody table changes: an agent still holds only a
-- delegation minted for one task, and the store asks its person's `docs:write` at business
-- scope.

alter table public.docs_folders
  add column task_id uuid,
  add column delegation_id uuid,
  add constraint docs_folders_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  add constraint docs_folders_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  add constraint docs_folders_agent_named_whole check ((task_id is null) = (delegation_id is null));

alter table public.docs_page_versions
  add column task_id uuid,
  add column delegation_id uuid,
  add constraint docs_page_versions_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  add constraint docs_page_versions_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  add constraint docs_page_versions_agent_named_whole
    check ((task_id is null) = (delegation_id is null));
