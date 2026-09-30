-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0060 S0-5: the gate's own commands (ORCH38). A gate item is ticked with its
-- evidence link (`operations.record_gate_item`) and the installation moves
-- from made-up to real data (`operations.change_installation_mode`), each a
-- person's act under `operations:manage` in the business that operates the
-- installation, audited by the command envelope.
--
-- The application writes through those commands with the narrowest grants
-- that let it: insert on `ops.gate_items` (no update or delete, so an item
-- once done stays done) and update of `mode` alone on `ops.installation`.
-- The one-way trigger from 0056 still refuses a move back, and a move to real
-- while any item is open, whoever asks.
--
-- `operator_business_id` names the business that operates the installation.
-- The gate is the installation's, not a tenant's, so only that business's
-- `operations:manage` may move it; another business on the same installation
-- is refused. It is set at provisioning by the owner, never by the
-- application; while it is unset the gate's commands are refused for
-- everyone.

alter table ops.installation
  add column operator_business_id uuid references public.businesses (id);

grant insert on ops.gate_items to ops_astro_app;
grant update (mode) on ops.installation to ops_astro_app;

-- A move stamps its own time, since the application may not write the column.
create function ops.installation_stamped() returns trigger
  language plpgsql
  set search_path = pg_catalog, ops
as $$
begin
  if new.mode is distinct from old.mode then
    new.changed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function ops.installation_stamped() from public;

create trigger installation_stamped
  before update on ops.installation
  for each row execute function ops.installation_stamped();
