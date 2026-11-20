create extension if not exists pgcrypto;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'LOBBY' check (status in ('LOBBY','IN_PROGRESS','GAME_OVER')),
  current_round_id uuid,
  round_number int not null default 0,
  max_rounds int not null default 5,
  version bigint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index one_active_game on public.games (is_active) where is_active;

create table public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 20),
  tokens int not null default 100 check (tokens >= 0),
  joined_at timestamptz not null default now()
);

create table public.cases (
  id text primary key,
  scenario text not null,
  hypothesis_a text not null,
  hypothesis_b text not null,
  evidence_json jsonb not null default '[]',
  image_url text not null,
  is_backup boolean not null default false,
  used_at timestamptz
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  case_id text not null references public.cases(id),
  round_number int not null,
  phase text not null check (phase in ('REVEAL','BETTING','OPENINGS','INJECT_1','REBUTTALS','INJECT_2','FINALS','JUDGING','RESULTS','CANCELLED')),
  phase_started_at timestamptz not null default now(),
  phase_ends_at timestamptz not null,
  ai_step_status text not null default 'idle' check (ai_step_status in ('idle','running','done','failed')),
  ai_step_started_at timestamptz,
  ai_error text,
  winner text check (winner in ('A','B')),
  settled_at timestamptz,
  unique (game_id, round_number)
);
alter table public.games add constraint games_current_round_fk
  foreign key (current_round_id) references public.rounds(id);

create table public.bets (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  side text not null check (side in ('A','B')),
  stake int not null check (stake > 0),
  placed_at timestamptz not null default now(),
  unique (round_id, player_id)
);

create table public.injections (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  inject_window smallint not null check (inject_window in (1,2)),
  side text not null check (side in ('A','B')),
  text text not null check (char_length(text) between 1 and 250),
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  unique (round_id, player_id, inject_window)
);

create table public.debate_messages (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  stage text not null check (stage in ('opening','rebuttal','final')),
  speaker text not null check (speaker in ('A','B')),
  line_text text not null,
  ordinal int not null,
  created_at timestamptz not null default now(),
  unique (round_id, stage, speaker)          -- makes AI writes idempotent
);

create table public.verdicts (
  round_id uuid primary key references public.rounds(id) on delete cascade,
  winner text not null check (winner in ('A','B')),
  rationale text not null,
  scores_json jsonb not null,
  created_at timestamptz not null default now()
);

create table public.token_ledger (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  round_id uuid references public.rounds(id) on delete cascade,
  type text not null check (type in ('grant','stake','payout','refund')),
  delta int not null,
  created_at timestamptz not null default now(),
  unique (player_id, round_id, type)        -- settlement can never double-pay
);

create view public.leaderboard with (security_invoker = true) as
select p.id, p.nickname, p.tokens,
       count(b.id) filter (where r.winner is not null and b.side = r.winner) as correct_picks
from public.players p
left join public.bets b on b.player_id = p.id
left join public.rounds r on r.id = b.round_id
group by p.id;

-- ================= RPCs (called only by the server with the secret key) =================

create or replace function public.place_bet(p_player uuid, p_round uuid, p_side text, p_stake int)
returns int language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_tokens int;
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase <> 'BETTING' or now() > v_ends then raise exception 'BETTING_CLOSED'; end if;
  if p_side not in ('A','B') or p_stake is null or p_stake <= 0 then raise exception 'BAD_REQUEST'; end if;
  if exists (select 1 from bets where round_id = p_round and player_id = p_player) then raise exception 'ALREADY_BET'; end if;
  update players set tokens = tokens - p_stake
   where id = p_player and tokens >= p_stake
   returning tokens into v_tokens;
  if v_tokens is null then raise exception 'INSUFFICIENT_TOKENS'; end if;
  insert into bets (round_id, player_id, side, stake) values (p_round, p_player, p_side, p_stake); -- 23505 on race → whole tx rolls back
  insert into token_ledger (player_id, round_id, type, delta) values (p_player, p_round, 'stake', -p_stake);
  return v_tokens;
end $$;

create or replace function public.submit_injection(p_player uuid, p_round uuid, p_window int, p_text text)
returns uuid language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_side text; v_id uuid; v_text text := btrim(p_text);
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase <> ('INJECT_' || p_window) or now() > v_ends then raise exception 'INJECTION_CLOSED'; end if;
  if v_text is null or char_length(v_text) = 0 or char_length(v_text) > 250 then raise exception 'BAD_REQUEST'; end if;
  select side into v_side from bets where round_id = p_round and player_id = p_player;
  if not found then raise exception 'NO_BET'; end if;
  insert into injections (round_id, player_id, inject_window, side, text)
  values (p_round, p_player, p_window, v_side, v_text) returning id into v_id;
  return v_id;
end $$;

create or replace function public.select_clues(p_round uuid, p_window int)
returns setof public.injections language plpgsql set search_path = public as $$
begin
  perform 1 from rounds where id = p_round for update;
  if not exists (select 1 from injections where round_id = p_round and inject_window = p_window and selected) then
    update injections set selected = true where id in (
      select id from (
        select id, row_number() over (partition by side order by random()) rn
        from injections where round_id = p_round and inject_window = p_window
      ) t where t.rn <= 3);
  end if;
  return query select * from injections
   where round_id = p_round and inject_window = p_window and selected
   order by side, created_at;
end $$;

-- Compare-and-set: a double-click changes the phase only once
create or replace function public.transition_phase(p_round uuid, p_expected text, p_next text, p_seconds int)
returns setof public.rounds language plpgsql set search_path = public as $$
begin
  return query
    update rounds set phase = p_next, phase_started_at = now(),
           phase_ends_at = now() + make_interval(secs => p_seconds),
           ai_step_status = 'idle', ai_error = null
     where id = p_round and phase = p_expected
     returning *;
  if found then update games set version = version + 1 where is_active; end if;
end $$;

create or replace function public.start_next_round(p_game uuid, p_expected_round_number int, p_reveal_seconds int)
returns setof public.rounds language plpgsql set search_path = public as $$
declare g games; v_case text; r rounds;
begin
  select * into g from games where id = p_game for update;
  if not found or g.round_number <> p_expected_round_number then return; end if; -- already done
  if g.round_number >= g.max_rounds then
    update games set status = 'GAME_OVER', version = version + 1 where id = p_game; return;
  end if;
  select id into v_case from cases where used_at is null order by is_backup, random() limit 1 for update skip locked;
  if v_case is null then raise exception 'NO_CASES_LEFT'; end if;
  update cases set used_at = now() where id = v_case;
  insert into rounds (game_id, case_id, round_number, phase, phase_ends_at)
  values (p_game, v_case, g.round_number + 1, 'REVEAL', now() + make_interval(secs => p_reveal_seconds))
  returning * into r;
  update games set current_round_id = r.id, round_number = r.round_number,
                   status = 'IN_PROGRESS', version = version + 1 where id = p_game;
  return next r;
end $$;

create or replace function public.settle_round(p_round uuid)
returns int language plpgsql set search_path = public as $$
declare v_settled timestamptz; v_winner text; v_count int;
begin
  select settled_at into v_settled from rounds where id = p_round for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;
  if v_settled is not null then return 0; end if;            -- idempotent
  select winner into v_winner from verdicts where round_id = p_round;
  if not found then raise exception 'NO_VERDICT'; end if;
  with paid as (
    insert into token_ledger (player_id, round_id, type, delta)
    select player_id, round_id, 'payout', stake * 2 from bets where round_id = p_round and side = v_winner
    on conflict (player_id, round_id, type) do nothing
    returning player_id, delta)
  update players p set tokens = p.tokens + paid.delta from paid where p.id = paid.player_id;
  get diagnostics v_count = row_count;
  update rounds set winner = v_winner, settled_at = now() where id = p_round;
  return v_count;
end $$;

create or replace function public.cancel_round(p_round uuid)
returns int language plpgsql set search_path = public as $$
declare v_settled timestamptz; v_count int;
begin
  select settled_at into v_settled from rounds where id = p_round for update;
  if not found then raise exception 'ROUND_NOT_FOUND'; end if;
  if v_settled is not null then return 0; end if;
  with refunded as (
    insert into token_ledger (player_id, round_id, type, delta)
    select player_id, round_id, 'refund', stake from bets where round_id = p_round
    on conflict (player_id, round_id, type) do nothing
    returning player_id, delta)
  update players p set tokens = p.tokens + refunded.delta from refunded where p.id = refunded.player_id;
  get diagnostics v_count = row_count;
  update rounds set phase = 'CANCELLED', settled_at = now(), phase_started_at = now(),
                    phase_ends_at = now() + interval '8 seconds' where id = p_round;
  update games set version = version + 1 where is_active;
  return v_count;
end $$;

create or replace function public.reset_game()  -- for rehearsals
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  update games set is_active = false where is_active;
  update cases set used_at = null;
  update players set tokens = 100;
  insert into games default values returning id into v_id;
  return v_id;
end $$;

-- ================= Lock everything down: browser never touches tables directly =================
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.cases enable row level security;
alter table public.rounds enable row level security;
alter table public.bets enable row level security;
alter table public.injections enable row level security;
alter table public.debate_messages enable row level security;
alter table public.verdicts enable row level security;
alter table public.token_ledger enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

insert into public.games default values;