-- Real database ownership/creation/privacy boundaries for unlinked players.
begin;
create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;
select plan(18);

insert into auth.users(id, is_anonymous, raw_user_meta_data) values
 ('b1111111-1111-4111-8111-111111111111', true, '{"username":"admin","display_name":"Administrator","is_anonymous":false,"balance":999999}'),
 ('b2222222-2222-4222-8222-222222222222', true, '{}'),
 ('b3333333-3333-4333-8333-333333333333', true, '{}');
select matches((select username::text from profiles where id='b1111111-1111-4111-8111-111111111111'), '^[a-z]+_[a-z]+(_[0-9]{6})?$', 'anonymous metadata cannot choose the canonical handle');
select ok((select username_is_permitted(username) from profiles where id='b1111111-1111-4111-8111-111111111111'), 'generated handles pass the same moderation as renames');
select ok((select display_name=username from profiles where id='b1111111-1111-4111-8111-111111111111'), 'default presentation follows the actual assigned handle');
select is((select balance from wallets where user_id='b1111111-1111-4111-8111-111111111111'), 25000::bigint, 'metadata cannot choose an opening grant');
update auth.users set is_anonymous=false, email='b-sql-secured@arc21.test' where id='b1111111-1111-4111-8111-111111111111';
select is((select count(*) from wallet_ledger where user_id='b1111111-1111-4111-8111-111111111111' and reason='initial_grant'), 1::bigint, 'securing the same UUID cannot re-run its opening grant');
select is((select balance from wallets where user_id='b1111111-1111-4111-8111-111111111111'), (select sum(delta)::bigint from wallet_ledger where user_id='b1111111-1111-4111-8111-111111111111'), 'wallet reconciles after identity conversion');
select ok(not has_table_privilege('authenticated','public.friend_requests','INSERT'), 'direct requests cannot bypass the RPC rate limit');
select ok(not has_function_privilege('anon','public.list_friend_presence()','EXECUTE'), 'public key alone cannot read presence');
select ok(not has_function_privilege('authenticated','public.generated_player_handle(boolean)','EXECUTE'), 'handle candidates are not a client allocation API');
select is((select count(*) from pg_policies where schemaname='realtime' and policyname in ('arc21_presence_roster_needs_an_account','arc21_only_presence_may_be_written_by_a_client')),0::bigint,'shared spoofable roster policies are removed');

insert into friendships(user_id_a,user_id_b) values ('b1111111-1111-4111-8111-111111111111','b2222222-2222-4222-8222-222222222222');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"b1111111-1111-4111-8111-111111111111","role":"authenticated","is_anonymous":true}',true);
select is((select count(*) from list_friend_presence()),1::bigint,'verified pseudonymous callers see their recently active friend');
select is((select user_id from list_friend_presence()),'b2222222-2222-4222-8222-222222222222'::uuid,'presence is scoped to accepted friendships');
select is((select count(*) from wallets where user_id='b2222222-2222-4222-8222-222222222222'),0::bigint,'anonymous role cannot read another wallet');
reset role;
insert into blocks(blocker_id,blocked_id) values ('b2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111');
set local role authenticated;
select is((select count(*) from list_friend_presence()),0::bigint,'a block in either direction hides activity');
reset role;
delete from blocks where blocker_id='b2222222-2222-4222-8222-222222222222';
update profiles set last_seen_at=now()-interval '91 seconds' where id='b2222222-2222-4222-8222-222222222222';
set local role authenticated;
select is((select count(*) from list_friend_presence()),0::bigint,'stale activity is not reported as recently active');
reset role;

-- Force a collision without assuming that random generation happened to collide.
insert into auth.users(id, raw_user_meta_data) values ('b4444444-4444-4444-8444-444444444444','{"username":"quiet_bison"}');
create or replace function public.generated_player_handle(p_suffixed boolean default false)
returns text language sql volatile set search_path=public,pg_temp as $$
 select case when p_suffixed then 'quiet_bison_000001' else 'quiet_bison' end;
$$;
insert into auth.users(id,is_anonymous) values ('b5555555-5555-4555-8555-555555555555',true);
select is((select username::text from profiles where id='b5555555-5555-4555-8555-555555555555'),'quiet_bison_000001','unique-index collision retries a filtered suffixed candidate');
select is((select count(*) from wallet_ledger where user_id='b5555555-5555-4555-8555-555555555555'),1::bigint,'collision retry creates only one grant');
select lives_ok('select public.assert_client_authorization_surface()','authorization gate still holds');
select * from finish();
rollback;
