-- Dialysis Worldwide – centre portal (partner dialysis centres)
-- Additive: creates one table and three functions. Existing tables and rules are not changed.
-- Centre accounts are NOT team members, so the existing rules (dw_is_member / dw_can_write)
-- keep them out of public.records entirely. They only get what portal_* functions return.

create table if not exists public.centre_users (
  email      text primary key,
  user_id    uuid unique,
  centre     text not null,           -- must match the centre name used on patients / sessions
  site       text not null default 'TN',
  name       text,
  status     text not null default 'invited',   -- invited | active | removed
  invited_at timestamptz not null default now(),
  joined_at  timestamptz,
  invited_by uuid
);
alter table public.centre_users enable row level security;
drop policy if exists "team can see centre users" on public.centre_users;
create policy "team can see centre users" on public.centre_users
  for select to authenticated using (public.dw_is_member());
-- No insert/update/delete policies: changes go through the centre-portal edge function (service role).

-- Which centre is the signed-in user? (null for everyone else)
create or replace function public.portal_me()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('centre', centre, 'site', site, 'name', name, 'email', email)
  from public.centre_users
  where user_id = auth.uid() and status <> 'removed'
  limit 1
$$;

-- Everything one centre may see: its patients (booking essentials only), their sessions,
-- and its own earnings + the commission it owes. Nothing else leaves the database.
create or replace function public.portal_data()
returns json language plpgsql stable security definer set search_path = public as $$
declare c record;
begin
  select centre, site into c from public.centre_users where user_id = auth.uid() and status <> 'removed' limit 1;
  if c.centre is null then raise exception 'not a centre account'; end if;
  return json_build_object(
    'centre', c.centre,
    'patients', coalesce((
      select json_agg(json_build_object(
        'id', r.id,
        'name', r.data->>'name',
        'nationality', r.data->>'nationality',
        'lang', r.data->>'lang',
        'arrival', r.data->>'arrival',
        'departure', r.data->>'departure',
        'hotel', r.data->>'hotel',
        'transfer', r.data->>'transfer',
        'mode', r.data->>'mode',
        'hours', r.data->>'hours',
        'perWeek', r.data->>'perWeek',
        'time', r.data->>'time',
        'stage', r.data->>'stage',
        'docs', (select coalesce(json_agg(k), '[]'::json) from jsonb_each_text(coalesce(r.data->'docs','{}'::jsonb)) d(k,v) where v = 'true'),
        'centreReply', r.data->'centreReply'
      ) order by r.data->>'arrival')
      from public.records r
      where r.collection = 'patients'
        and r.data->>'center' = c.centre
        and coalesce(r.data->>'stage','') in ('docs','quote','confirmed','treatment','done')
    ), '[]'::json),
    'sessions', coalesce((
      select json_agg(json_build_object(
        'id', s.id, 'patientId', s.data->>'patientId', 'date', s.data->>'date', 'time', s.data->>'time',
        'status', s.data->>'status', 'mode', s.data->>'mode', 'centreReply', s.data->'centreReply'
      ) order by s.data->>'date', s.data->>'time')
      from public.records s
      where s.collection = 'sessions' and s.data->>'center' = c.centre
    ), '[]'::json),
    'earnings', coalesce((
      select json_agg(json_build_object(
        'id', m.id, 'date', m.data->>'date', 'name', m.data->>'name', 'currency', 'TND',
        'sessions', coalesce(nullif(m.data->>'sessions','')::numeric, 0),
        'fee', coalesce(nullif(m.data->>'centerFee','')::numeric, 0),
        'earned', coalesce(nullif(m.data->>'centerFee','')::numeric, 0) * coalesce(nullif(m.data->>'sessions','')::numeric, 0),
        'commission', round(greatest(
            coalesce(nullif(m.data->>'totalPaidEuro','')::numeric, 0) * coalesce(nullif(m.data->>'exchangeRate','')::numeric, 1)
          - coalesce(nullif(m.data->>'centerFee','')::numeric, 0) * coalesce(nullif(m.data->>'sessions','')::numeric, 0), 0)
          * coalesce(nullif(m.data->>'commissionRate','')::numeric, 0) / 100, 2),
        'status', coalesce(m.data->>'status','unpaid')
      ) order by m.data->>'date' desc)
      from public.records m
      where m.collection = 'commissions' and m.data->>'center' = c.centre
    ), '[]'::json)
  );
end $$;

-- A centre answers a patient request: accept, refuse or propose other times.
-- p_times: [{"sessionId": "...", "date": "2026-12-03", "time": "08:00"}, ...] (only for 'propose')
create or replace function public.portal_respond(p_patient_id text, p_action text, p_note text default '', p_times jsonb default '[]'::jsonb)
returns json language plpgsql volatile security definer set search_path = public as $$
declare c record; reply jsonb; t jsonb;
begin
  select centre, email into c from public.centre_users where user_id = auth.uid() and status <> 'removed' limit 1;
  if c.centre is null then raise exception 'not a centre account'; end if;
  if p_action not in ('accept','refuse','propose') then raise exception 'unknown action'; end if;
  if not exists (select 1 from public.records where collection = 'patients' and id = p_patient_id and data->>'center' = c.centre) then
    raise exception 'this patient is not booked at your centre';
  end if;
  reply := jsonb_build_object('action', p_action, 'note', left(coalesce(p_note,''), 1000), 'times', coalesce(p_times,'[]'::jsonb),
                              'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'by', c.email, 'seen', false);
  update public.records set data = data || jsonb_build_object('centreReply', reply), updated_at = now()
   where collection = 'patients' and id = p_patient_id;
  -- sessions of this patient at this centre
  update public.records set data = data
      || jsonb_build_object('centreReply', reply - 'times' - 'seen')
      || case when p_action = 'accept' and data->>'status' = 'planned' then jsonb_build_object('status','confirmed') else '{}'::jsonb end,
      updated_at = now()
   where collection = 'sessions' and data->>'patientId' = p_patient_id and data->>'center' = c.centre;
  -- proposed time per session
  if p_action = 'propose' then
    for t in select * from jsonb_array_elements(coalesce(p_times,'[]'::jsonb)) loop
      update public.records set data = data || jsonb_build_object('proposed', jsonb_build_object('date', t->>'date', 'time', t->>'time')), updated_at = now()
       where collection = 'sessions' and id = t->>'sessionId' and data->>'center' = c.centre;
    end loop;
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.portal_data() from public, anon;
revoke all on function public.portal_respond(text, text, text, jsonb) from public, anon;
revoke all on function public.portal_me() from public, anon;
grant execute on function public.portal_me() to authenticated;
grant execute on function public.portal_data() to authenticated;
grant execute on function public.portal_respond(text, text, text, jsonb) to authenticated;
