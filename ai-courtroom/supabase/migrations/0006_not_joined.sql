-- 0006: a signed-in user who never called /api/join got misleading errors (bet → INSUFFICIENT_TOKENS, clue → NO_BET).
-- Both RPCs now raise NOT_JOINED when there is no players row. Otherwise identical to 0001 (place_bet) / 0003 (submit_injection).
-- Safe to re-run.
create or replace function public.place_bet(p_player uuid, p_round uuid, p_side text, p_stake int)
returns int language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_tokens int;
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase <> 'BETTING' or now() > v_ends then raise exception 'BETTING_CLOSED'; end if;
  if p_side not in ('A','B') or p_stake is null or p_stake <= 0 then raise exception 'BAD_REQUEST'; end if;
  if not exists (select 1 from players where id = p_player) then raise exception 'NOT_JOINED'; end if;
  if exists (select 1 from bets where round_id = p_round and player_id = p_player) then raise exception 'ALREADY_BET'; end if;
  update players set tokens = tokens - p_stake
   where id = p_player and tokens >= p_stake
   returning tokens into v_tokens;
  if v_tokens is null then raise exception 'INSUFFICIENT_TOKENS'; end if;
  insert into bets (round_id, player_id, side, stake) values (p_round, p_player, p_side, p_stake); -- 23505 on race → whole tx rolls back
  insert into token_ledger (player_id, round_id, type, delta) values (p_player, p_round, 'stake', -p_stake);
  return v_tokens;
end $$;

create or replace function public.submit_injection(p_player uuid, p_round uuid, p_text text)
returns uuid language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_side text; v_id uuid; v_text text := btrim(p_text);
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase not in ('OPENINGS','DEBATE') or now() > v_ends then raise exception 'INJECTION_CLOSED'; end if;
  if v_text is null or char_length(v_text) = 0 or char_length(v_text) > 200 then raise exception 'BAD_REQUEST'; end if;
  if not exists (select 1 from players where id = p_player) then raise exception 'NOT_JOINED'; end if;
  select side into v_side from bets where round_id = p_round and player_id = p_player;
  if not found then raise exception 'NO_BET'; end if;
  insert into injections (round_id, player_id, side, text)
  values (p_round, p_player, v_side, v_text) returning id into v_id;   -- 23505 = ALREADY_INJECTED
  return v_id;
end $$;

revoke execute on function public.place_bet(uuid, uuid, text, int) from public, anon, authenticated;
revoke execute on function public.submit_injection(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.place_bet(uuid, uuid, text, int) to service_role;
grant execute on function public.submit_injection(uuid, uuid, text) to service_role;
