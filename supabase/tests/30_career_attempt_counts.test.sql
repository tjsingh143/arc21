-- SQL primitive/permission coverage. The real start/play/replay caller is
-- separately exercised by tests/server/career.integration.test.ts.
begin;
create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;
select plan(10);

select is((select count(*)::integer from public.career_progress p where p.attempts <>
  (select count(*) from public.career_attempts a where a.user_id = p.user_id
    and a.career_node_id = p.career_node_id)), 0, 'migration repaired existing counts from actual attempts');

select function_privs_are('public', 'record_career_completion',
  array['uuid', 'uuid', 'integer', 'bigint', 'timestamp with time zone'],
  'authenticated', array[]::text[], 'clients cannot record a completion');
select function_privs_are('public', 'record_career_completion',
  array['uuid', 'uuid', 'integer', 'bigint', 'timestamp with time zone'],
  'anon', array[]::text[], 'anonymous callers cannot record a completion');
select function_privs_are('public', 'record_career_completion',
  array['uuid', 'uuid', 'integer', 'bigint', 'timestamp with time zone'],
  'service_role', array[]::text[], 'service role cannot record a completion');

insert into auth.users (id, email, aud, role) values
  ('30000000-0000-4000-8000-000000000030', 'count-regression@arc21.test', 'authenticated', 'authenticated');
select public.record_career_attempt_started('30000000-0000-4000-8000-000000000030',
  (select id from public.career_nodes where code = 'first-deal'));
select is((select attempts from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  1, 'first start counts once');
select public.record_career_completion('30000000-0000-4000-8000-000000000030',
  (select id from public.career_nodes where code = 'first-deal'), 3, 2200);
select is((select attempts from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  1, 'completion does not count the same attempt again');
select public.record_career_attempt_started('30000000-0000-4000-8000-000000000030',
  (select id from public.career_nodes where code = 'first-deal'));
select public.record_career_completion('30000000-0000-4000-8000-000000000030',
  (select id from public.career_nodes where code = 'first-deal'), 1, 1000);
select is((select attempts from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  2, 'a completed replay is exactly the second attempt');
select is((select stars from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  3, 'a worse replay keeps the best stars');
select is((select best_score from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  2200::bigint, 'a worse replay keeps the best score');
select public.record_career_attempt_started('30000000-0000-4000-8000-000000000030',
  (select id from public.career_nodes where code = 'first-deal'));
select is((select attempts from public.career_progress where user_id = '30000000-0000-4000-8000-000000000030'),
  3, 'an unfinished or abandoned run still counts');
select * from finish();
rollback;
