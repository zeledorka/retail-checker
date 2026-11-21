-- 0005: Supabase's Data API (PostgREST) runs with the `safeupdate` guard, which rejects any UPDATE without a
-- WHERE clause ("UPDATE requires a WHERE clause", 21000) — even inside an RPC. reset_game() had three, so
-- POST /api/admin/reset always failed. Same behavior, explicit `where true`. Safe to re-run.
create or replace function public.reset_game()
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  update games set is_active = false where is_active;
  update cases set used_at = null where true;
  update players set tokens = 100 where true;
  update ai_round_states set lease_owner = null, lease_expires_at = null where true;
  insert into games default values returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.reset_game() from public, anon, authenticated;
grant execute on function public.reset_game() to service_role;
