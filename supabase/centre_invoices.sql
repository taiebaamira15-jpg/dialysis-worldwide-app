-- Dialysis Worldwide – centre window: invoices + live refresh (11 Nov 2026). Re-runnable.
-- portal_data() now also returns the invoices of the patients sent to the centre, with the centre's share
-- (same maths as the Commissions page). portal_stamp() is a tiny "has anything changed?" check the
-- centre window asks every few seconds, so new invoices, sessions and patient changes appear on their own.

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
    'invoices', coalesce((
      select json_agg(json_build_object(
        'id', i.id, 'number', i.data->>'number', 'patientId', i.data->>'patientId', 'name', r.data->>'name',
        'issued', i.data->>'issued', 'due', i.data->>'due', 'status', coalesce(i.data->>'status','unpaid'), 'paidAt', i.data->>'paidAt',
        'currency', coalesce(i.data->>'currency','EUR'), 'total', round(y.total, 2), 'sessions', y.sessions,
        'paidTnd', round(y.paid, 2), 'fee', y.fee, 'rate', y.pct,
        'commission', round(greatest(y.paid - y.fee * y.sessions, 0) * y.pct / 100, 2),
        'earned', round(y.paid - greatest(y.paid - y.fee * y.sessions, 0) * y.pct / 100, 2)
      ) order by i.data->>'issued' desc, i.data->>'number' desc)
      from public.records i
      join public.records r on r.collection = 'patients' and r.id = i.data->>'patientId'
           and r.data->>'center' = c.centre and r.data->'sentToCentre'->>'centre' = c.centre
      left join lateral (select data from public.records m where m.collection = 'commissions' and m.data->>'invoiceId' = i.id limit 1) cm on true
      cross join lateral (
        select t.total, t.sessions,
               coalesce(nullif(cm.data->>'centerFee','')::numeric, nullif(st.data->'money'->>'centerFee','')::numeric, 200) as fee,
               coalesce(nullif(cm.data->>'commissionRate','')::numeric, nullif(st.data->'money'->>'commission','')::numeric, 20) as pct,
               t.total * case when coalesce(i.data->>'currency','EUR') = 'TND' then 1
                              else coalesce(nullif(cm.data->>'exchangeRate','')::numeric, nullif(st.data->'money'->>'rate','')::numeric, 3.4) end as paid
        from (select (select data from public.records where collection = 'settings' and id = 'main') as data) st,
        lateral (
          select coalesce(sum(coalesce(nullif(it->>'qty','')::numeric,0) * coalesce(nullif(it->>'unit','')::numeric,0)), 0) as total,
                 coalesce(nullif(sum(case when it->>'desc' ~* '(dialys|session|séance)' then coalesce(nullif(it->>'qty','')::numeric,0) else 0 end), 0),
                          (select coalesce(nullif(x->>'qty','')::numeric,0) from jsonb_array_elements(coalesce(i.data->'items','[]'::jsonb)) x limit 1), 0) as sessions
          from jsonb_array_elements(coalesce(i.data->'items','[]'::jsonb)) it
        ) t
      ) y
      where i.collection = 'invoices' and coalesce(i.data->>'status','') <> 'cancelled'
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

create or replace function public.portal_stamp()
returns text language plpgsql stable security definer set search_path = public as $$
declare c record; v text;
begin
  select centre into c from public.centre_users where user_id = auth.uid() and status <> 'removed' limit 1;
  if c.centre is null then raise exception 'not a centre account'; end if;
  with pts as (
    select id, updated_at from public.records
     where collection = 'patients' and data->>'center' = c.centre and data->'sentToCentre'->>'centre' = c.centre)
  select concat_ws('|',
    (select count(*)::text || '-' || coalesce(max(updated_at)::text,'') from pts),
    (select count(*)::text || '-' || coalesce(max(s.updated_at)::text,'') from public.records s
       where s.collection = 'sessions' and s.data->>'center' = c.centre and s.data->>'patientId' in (select id from pts)),
    (select count(*)::text || '-' || coalesce(max(i.updated_at)::text,'') from public.records i
       where i.collection = 'invoices' and i.data->>'patientId' in (select id from pts)),
    (select count(*)::text || '-' || coalesce(max(m.updated_at)::text,'') from public.records m
       where m.collection = 'commissions' and m.data->>'center' = c.centre),
    (select coalesce(updated_at::text,'') from public.records where collection = 'settings' and id = 'main'))
  into v;
  return v;
end $$;
revoke all on function public.portal_stamp() from public, anon;
grant execute on function public.portal_stamp() to authenticated;
