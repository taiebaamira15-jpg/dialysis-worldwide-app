-- Dialysis Worldwide – files attached to "Send patient for confirmation".
-- Private bucket centre-files, one folder per patient: <patientId>/<file>.
-- Team members upload and read; a centre account can only read the files of patients sent to its centre.
-- The file list is stored on the patient: sentToCentre.files = [{name, path, size, type}]. Re-runnable.

insert into storage.buckets (id, name, public, file_size_limit)
values ('centre-files', 'centre-files', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "centre files: team reads" on storage.objects;
create policy "centre files: team reads" on storage.objects for select to authenticated
  using (bucket_id = 'centre-files' and public.dw_is_member());

drop policy if exists "centre files: team uploads" on storage.objects;
create policy "centre files: team uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'centre-files' and public.dw_can_write());

drop policy if exists "centre files: team deletes" on storage.objects;
create policy "centre files: team deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'centre-files' and public.dw_can_write());

-- a centre account may read a file only if its patient was sent to that centre (checked with owner rights,
-- because centre accounts cannot read records / centre_users themselves)
create or replace function public.centre_can_read_file(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.centre_users cu
    join public.records r on r.collection = 'patients' and r.id = split_part(p_name, '/', 1)
    where cu.user_id = auth.uid() and cu.status <> 'removed'
      and r.data->>'center' = cu.centre and r.data->'sentToCentre'->>'centre' = cu.centre)
$$;
revoke all on function public.centre_can_read_file(text) from public, anon;
grant execute on function public.centre_can_read_file(text) to authenticated;

drop policy if exists "centre files: centre reads its patients" on storage.objects;
create policy "centre files: centre reads its patients" on storage.objects for select to authenticated
  using (bucket_id = 'centre-files' and public.centre_can_read_file(name));

-- the portal also returns the file list of each patient
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
        'sentAt', r.data->'sentToCentre'->>'at',
        'files', coalesce(r.data->'sentToCentre'->'files', '[]'::jsonb),
        'docs', (select coalesce(json_agg(k), '[]'::json) from jsonb_each_text(coalesce(r.data->'docs','{}'::jsonb)) d(k,v) where v = 'true'),
        'centreReply', r.data->'centreReply'
      ) order by r.data->>'arrival')
      from public.records r
      where r.collection = 'patients' and r.data->>'center' = c.centre and r.data->'sentToCentre'->>'centre' = c.centre
    ), '[]'::json),
    'sessions', coalesce((
      select json_agg(json_build_object(
        'id', s.id, 'patientId', s.data->>'patientId', 'date', s.data->>'date', 'time', s.data->>'time',
        'status', s.data->>'status', 'mode', s.data->>'mode', 'centreReply', s.data->'centreReply'
      ) order by s.data->>'date', s.data->>'time')
      from public.records s
      where s.collection = 'sessions' and s.data->>'center' = c.centre
        and exists (select 1 from public.records r where r.collection = 'patients' and r.id = s.data->>'patientId'
                    and r.data->>'center' = c.centre and r.data->'sentToCentre'->>'centre' = c.centre)
    ), '[]'::json),
    'earnings', coalesce((
      select json_agg(json_build_object(
        'id', m.id, 'date', m.data->>'date', 'name', m.data->>'name', 'currency', 'TND',
        'sessions', x.sessions, 'fee', x.fee, 'rate', x.pct,
        'paid', round(x.paid, 2),
        'commission', round((x.paid - x.fee * x.sessions) * x.pct / 100, 2),
        'earned', round(x.paid - (x.paid - x.fee * x.sessions) * x.pct / 100, 2),
        'status', coalesce(m.data->>'status','unpaid')
      ) order by m.data->>'date' desc)
      from public.records m
      cross join lateral (
        select coalesce(nullif(m.data->>'sessions','')::numeric, 0) as sessions,
               coalesce(nullif(m.data->>'centerFee','')::numeric, nullif(st.data->'money'->>'centerFee','')::numeric, 200) as fee,
               coalesce(nullif(m.data->>'commissionRate','')::numeric, nullif(st.data->'money'->>'commission','')::numeric, 20) as pct,
               coalesce(nullif(m.data->>'totalPaidEuro','')::numeric, 0)
                 * coalesce(nullif(m.data->>'exchangeRate','')::numeric, nullif(st.data->'money'->>'rate','')::numeric, 3.4) as paid
        from (select (select data from public.records where collection = 'settings' and id = 'main') as data) st
      ) x
      where m.collection = 'commissions' and m.data->>'center' = c.centre
    ), '[]'::json)
  );
end $$;
