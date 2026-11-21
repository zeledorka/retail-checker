-- 0008: audience clues are accepted from BETTING (as soon as the player has bet) through DEBATE, so players have time
-- to write one. Otherwise identical to 0006's submit_injection (NOT_JOINED, NO_BET, one clue per player per round).
-- No UPDATE statements here (nothing for safeupdate to reject). Safe to re-run.
create or replace function public.submit_injection(p_player uuid, p_round uuid, p_text text)
returns uuid language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_side text; v_id uuid; v_text text := btrim(p_text);
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase not in ('BETTING','OPENINGS','DEBATE') or now() > v_ends then raise exception 'INJECTION_CLOSED'; end if;
  if v_text is null or char_length(v_text) = 0 or char_length(v_text) > 200 then raise exception 'BAD_REQUEST'; end if;
  if not exists (select 1 from players where id = p_player) then raise exception 'NOT_JOINED'; end if;
  select side into v_side from bets where round_id = p_round and player_id = p_player;
  if not found then raise exception 'NO_BET'; end if;
  insert into injections (round_id, player_id, side, text)
  values (p_round, p_player, v_side, v_text) returning id into v_id;   -- 23505 = ALREADY_INJECTED
  return v_id;
end $$;

-- Grants as in 0004/0006: server key only.
revoke execute on function public.submit_injection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.submit_injection(uuid, uuid, text) to service_role;
