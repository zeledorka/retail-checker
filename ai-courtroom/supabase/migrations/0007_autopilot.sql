-- 0007: server-side autopilot. When games.autopilot is true, GET /api/state advances the game itself (via after()),
-- so no laptop script or projector tab has to call /api/admin/tick. Safe to re-run.
alter table public.games add column if not exists autopilot boolean not null default false;

-- Toggle autopilot on the active game and bump `version` so polling clients pick the change up. Returns the new value.
create or replace function public.set_autopilot(p_enabled boolean)
returns boolean language plpgsql set search_path = public as $$
declare v boolean;
begin
  update games set autopilot = p_enabled, version = version + 1 where is_active returning autopilot into v;
  if not found then raise exception 'No active game'; end if;
  return v;
end $$;

-- reset_game (0005) + autopilot off. The new game also starts with the column default (false).
create or replace function public.reset_game()
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  update games set is_active = false, autopilot = false where is_active;
  update cases set used_at = null where true;
  update players set tokens = 100 where true;
  update ai_round_states set lease_owner = null, lease_expires_at = null where true;
  insert into games default values returning id into v_id;
  return v_id;
end $$;

-- Grants as in 0004/0005: server key only.
revoke execute on function public.set_autopilot(boolean) from public, anon, authenticated;
grant execute on function public.set_autopilot(boolean) to service_role;
revoke execute on function public.reset_game() from public, anon, authenticated;
grant execute on function public.reset_game() to service_role;
grant select, insert, update, delete on public.games to service_role;
