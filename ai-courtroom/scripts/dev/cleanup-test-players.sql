-- One-off: remove simulate.ts test players before a demo so the leaderboard starts clean.
-- Run ONLY before players arrive:  npx tsx --env-file=.env scripts/dev/db.ts apply scripts/dev/cleanup-test-players.sql
-- Deleting the auth user cascades to public.players → bets, injections, token_ledger (rounds/cases stay as history).
-- Exact nicknames (not LIKE 'Sim%') so a real player called e.g. "Simon" is never touched.
delete from auth.users
 where id in (select id from public.players
               where nickname in ('SimAlice','SimBob','SimCarol','SimDave','SimErin','SimAudit'));
-- Anonymous sign-ins that never joined (get-token.ts / test leftovers). Before doors open nobody real is in this state.
delete from auth.users u
 where u.is_anonymous
   and not exists (select 1 from public.players p where p.id = u.id);
