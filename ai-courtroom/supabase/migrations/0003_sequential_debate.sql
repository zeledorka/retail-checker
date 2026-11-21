-- 0003: switch from the old parallel debate (INJECT_1/REBUTTALS/INJECT_2/FINALS, top-3 clues)
-- to Dev 1's sequential engine (ai/INTEGRATION.md):
--   2 openings (A then B) -> 8 sequential turns (A,B,A,B...) -> 1 independent judge = 11 model calls.
-- Audience: ONE submission per player per round, ALL submissions go to the AI (no top-3 sampling).
-- AI memory: one AiRoundState JSON per round, saved with a lease + compare-and-swap on `revision`.
-- Run AFTER 0001 and 0002, in the Supabase SQL Editor.

-- ================= cases: match the AI's Scenario { title, description, evidence, interpretationA/B } =================
alter table public.cases rename column scenario to description;
alter table public.cases rename column hypothesis_a to interpretation_a;
alter table public.cases rename column hypothesis_b to interpretation_b;
alter table public.cases add column if not exists title text not null default 'Untitled case';
alter table public.cases alter column image_url drop not null;   -- an imageless fallback case is allowed (never fake a URL)

-- ================= rounds: new phase list =================
-- Old rounds that are mid-way through a removed phase are closed off so the new constraint can apply.
update public.rounds set phase = 'CANCELLED'
 where phase not in ('REVEAL','BETTING','OPENINGS','JUDGING','RESULTS','CANCELLED');
alter table public.rounds drop constraint if exists rounds_phase_check;
alter table public.rounds add constraint rounds_phase_check
  check (phase in ('REVEAL','BETTING','OPENINGS','DEBATE','JUDGING','RESULTS','CANCELLED'));
-- Consecutive failed AI calls in the current phase (the autopilot retries a few times, then cancels/pauses).
alter table public.rounds add column if not exists ai_failures int not null default 0;
alter table public.rounds add column if not exists ai_error_retryable boolean not null default true;

-- ================= injections: one per player per round, no windows, no sampling =================
alter table public.injections drop constraint if exists injections_round_id_player_id_inject_window_key;
alter table public.injections drop column if exists inject_window;
alter table public.injections drop column if exists selected;
alter table public.injections drop constraint if exists injections_text_check;
alter table public.injections add constraint injections_text_check check (char_length(text) between 1 and 200); -- the AI cuts at 200
alter table public.injections add constraint injections_round_player_key unique (round_id, player_id);
drop function if exists public.select_clues(uuid, int);
drop function if exists public.submit_injection(uuid, uuid, int, text);

-- ================= debate_messages: sequence 1..10 instead of fixed stages =================
delete from public.debate_messages where stage not in ('opening');   -- old rebuttal/final rows are meaningless now
alter table public.debate_messages drop constraint if exists debate_messages_round_id_stage_speaker_key;
alter table public.debate_messages drop constraint if exists debate_messages_stage_check;
alter table public.debate_messages add constraint debate_messages_stage_check check (stage in ('opening','turn'));
alter table public.debate_messages add column if not exists arg_key text;          -- PublicArgument.key, e.g. "<round>:turn3:A"
alter table public.debate_messages add column if not exists debate_turn int;       -- 1..8 for turns, null for openings
update public.debate_messages set arg_key = round_id || ':opening:' || speaker where arg_key is null;
alter table public.debate_messages alter column arg_key set not null;
alter table public.debate_messages add constraint debate_messages_arg_key_key unique (arg_key);
alter table public.debate_messages add constraint debate_messages_round_ordinal_key unique (round_id, ordinal);

-- ================= verdicts: keep the full public verdict from the judge =================
alter table public.verdicts add column if not exists summary text;
alter table public.verdicts add column if not exists verdict_json jsonb;           -- full JudgeVerdict (public once revealed)
alter table public.verdicts add column if not exists complete boolean not null default true;  -- false = judged a debate cut short by the clock
alter table public.verdicts add column if not exists turns_completed int not null default 0;

-- ================= AI round state (server-only) =================
-- Contains private audience messages + player ids. RLS on, no grants: only the secret-key server can read it.
create table if not exists public.ai_round_states (
  round_id uuid primary key references public.rounds(id) on delete cascade,
  state jsonb not null,
  revision int not null default 0,
  lease_owner uuid,                 -- which request is currently calling the model for this round
  lease_expires_at timestamptz,     -- a crashed request's lease simply expires
  updated_at timestamptz not null default now()
);
alter table public.ai_round_states enable row level security;
revoke all on public.ai_round_states from anon, authenticated;

-- ================= RPCs =================

-- One clue per player per round, only while OPENINGS or DEBATE is open, only for the side they bet on.
create or replace function public.submit_injection(p_player uuid, p_round uuid, p_text text)
returns uuid language plpgsql set search_path = public as $$
declare v_phase text; v_ends timestamptz; v_side text; v_id uuid; v_text text := btrim(p_text);
begin
  select phase, phase_ends_at into v_phase, v_ends from rounds where id = p_round for share;
  if not found or v_phase not in ('OPENINGS','DEBATE') or now() > v_ends then raise exception 'INJECTION_CLOSED'; end if;
  if v_text is null or char_length(v_text) = 0 or char_length(v_text) > 200 then raise exception 'BAD_REQUEST'; end if;
  select side into v_side from bets where round_id = p_round and player_id = p_player;
  if not found then raise exception 'NO_BET'; end if;
  insert into injections (round_id, player_id, side, text)
  values (p_round, p_player, v_side, v_text) returning id into v_id;   -- 23505 = ALREADY_INJECTED
  return v_id;
end $$;

-- Phase change also resets the AI failure counter.
create or replace function public.transition_phase(p_round uuid, p_expected text, p_next text, p_seconds int)
returns setof public.rounds language plpgsql set search_path = public as $$
begin
  return query
    update rounds set phase = p_next, phase_started_at = now(),
           phase_ends_at = now() + make_interval(secs => p_seconds),
           ai_step_status = 'idle', ai_error = null, ai_failures = 0, ai_error_retryable = true
     where id = p_round and phase = p_expected
     returning *;
  if found then update games set version = version + 1 where is_active; end if;
end $$;

-- Take the per-round lease. Returns the stored state + revision only if THIS caller now owns it.
-- Two simultaneous run-ai/tick calls: exactly one gets a row back, the other gets nothing and backs off.
create or replace function public.claim_ai_lease(p_round uuid, p_owner uuid, p_seconds int)
returns table (state jsonb, revision int) language plpgsql set search_path = public as $$
#variable_conflict use_column
begin
  return query
    update ai_round_states s
       set lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => p_seconds)
     where s.round_id = p_round and (s.lease_owner is null or s.lease_expires_at < now())
     returning s.state, s.revision;
end $$;

create or replace function public.release_ai_lease(p_round uuid, p_owner uuid)
returns void language sql set search_path = public as $$
  update ai_round_states set lease_owner = null, lease_expires_at = null
   where round_id = p_round and lease_owner = p_owner;
$$;

-- Commit ONE successful AI step atomically:
--   new state (compare-and-swap on revision AND lease owner) + the public debate line and/or verdict
--   + the round's ai status (only if the round is still in the phase that ran the step) + version bump.
-- Returns false (and changes nothing) if another request got there first: the caller discards its result.
create or replace function public.commit_ai_step(
  p_round uuid, p_owner uuid, p_phase text,
  p_expected_revision int, p_new_revision int, p_state jsonb,
  p_message jsonb,        -- null, or { key, side, stage, sequence, debateTurn, text }
  p_verdict jsonb,        -- null, or { winner, explanation, summary, scores, verdict, complete, turnsCompleted }
  p_ai_status text)       -- 'idle' (more work in this phase) or 'done'
returns boolean language plpgsql set search_path = public as $$
begin
  update ai_round_states
     set state = p_state, revision = p_new_revision, lease_owner = null, lease_expires_at = null, updated_at = now()
   where round_id = p_round and lease_owner = p_owner and revision = p_expected_revision;
  if not found then return false; end if;

  if p_message is not null then
    insert into debate_messages (round_id, stage, speaker, line_text, ordinal, arg_key, debate_turn)
    values (p_round, p_message->>'stage', p_message->>'side', p_message->>'text',
            (p_message->>'sequence')::int, p_message->>'key', (p_message->>'debateTurn')::int)
    on conflict (arg_key) do nothing;
  end if;

  if p_verdict is not null then
    insert into verdicts (round_id, winner, rationale, summary, scores_json, verdict_json, complete, turns_completed)
    values (p_round, p_verdict->>'winner', p_verdict->>'explanation', p_verdict->>'summary',
            p_verdict->'scores', p_verdict->'verdict',
            coalesce((p_verdict->>'complete')::boolean, true), coalesce((p_verdict->>'turnsCompleted')::int, 0))
    on conflict (round_id) do nothing;          -- a verdict is stored once; settle_round pays once
  end if;

  update rounds set ai_step_status = p_ai_status, ai_error = null, ai_failures = 0, ai_error_retryable = true
   where id = p_round and phase = p_phase;
  update games set version = version + 1 where is_active;
  return true;
end $$;

-- reset_game also clears AI leases (old rounds stay for history).
create or replace function public.reset_game()
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  update games set is_active = false where is_active;
  update cases set used_at = null;
  update players set tokens = 100;
  update ai_round_states set lease_owner = null, lease_expires_at = null;
  insert into games default values returning id into v_id;
  return v_id;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
