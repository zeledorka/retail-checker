-- 0004: the server (secret key = service_role) must be able to use every table and RPC.
-- Some Supabase projects do not grant default privileges on new tables/functions, and 0001/0003
-- revoke function execute from PUBLIC, so service_role got "permission denied" everywhere.
-- anon/authenticated stay locked out (browser never touches tables directly). Safe to re-run.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant execute on functions to service_role;
