-- Attempts are counted when START_CAREER_NODE creates them. Completion used
-- to increment the same aggregate again, so one completed run displayed two
-- attempts. Preserve the start count while folding best scores and rewards.
create or replace function public.record_career_completion(
  p_user_id uuid,
  p_node_id uuid,
  p_stars integer,
  p_score bigint,
  p_at timestamptz default now()
)
returns public.career_progress
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.career_progress;
begin
  if p_stars < 0 or p_stars > 3 then
    raise exception 'stars out of range: %', p_stars using errcode = '22023';
  end if;

  insert into public.career_progress
    (user_id, career_node_id, status, stars, best_score, attempts, first_completed_at)
  values
    (p_user_id, p_node_id, 'completed', p_stars, greatest(p_score, 0), 1, p_at)
  on conflict (user_id, career_node_id) do update set
    status = 'completed',
    stars = greatest(public.career_progress.stars, excluded.stars),
    best_score = greatest(public.career_progress.best_score, excluded.best_score),
    first_completed_at = coalesce(public.career_progress.first_completed_at, excluded.first_completed_at)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.record_career_completion(uuid, uuid, integer, bigint, timestamptz)
  from public, anon, authenticated, service_role;

comment on function public.record_career_completion(uuid, uuid, integer, bigint, timestamptz) is
  'Folds completion into best stars/score without counting the start again. '
  'Pays nothing; first-completion rewards remain ledger-backed in the Edge Function.';

-- Repair historical aggregates from the attempt records, including completed,
-- abandoned, and still-open attempts. This never touches chips, XP or stars.
update public.career_progress p
set attempts = (
  select count(*)::integer from public.career_attempts a
  where a.user_id = p.user_id and a.career_node_id = p.career_node_id
)
where p.attempts <> (
  select count(*)::integer from public.career_attempts a
  where a.user_id = p.user_id and a.career_node_id = p.career_node_id
);
