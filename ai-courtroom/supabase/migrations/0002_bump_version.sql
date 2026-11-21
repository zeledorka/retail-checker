""" This lets the engine say 'state changed' after AI output in lib\game\admin.ts """
create or replace function public.bump_version()
returns void language sql set search_path = public as $$
  update games set version = version + 1 where is_active;
$$;
revoke execute on function public.bump_version() from public, anon, authenticated;