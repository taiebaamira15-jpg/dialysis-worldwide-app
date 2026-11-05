-- Dialysis Worldwide – "Send patient for confirmation".
-- A centre now sees a patient only after the team presses "Send to centre" in the patient file
-- (patient.sentToCentre = {centre, at, by}). Replaces the earlier stage-based rule.
-- Emails: the send email goes out at once (centre-portal function); date/time changes are grouped (2 min);
-- the centre's answer emails the team at once. Re-runnable.

create or replace function public.centre_notify_visible(d jsonb)
returns boolean language sql immutable as $$
  select coalesce(d->'sentToCentre'->>'centre','') <> '' and d->'sentToCentre'->>'centre' = coalesce(d->>'center','')
$$;

create or replace function public.centre_notify_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
declare n jsonb; o jsonb; v_pid text; v_centre text; p jsonb;
begin
  n := case when tg_op = 'DELETE' then null else new.data end;
  o := case when tg_op = 'INSERT' then null else old.data end;
  if coalesce(new.collection, old.collection) = 'patients' then
    if n is null or not centre_notify_visible(n) or n->>'stage' = 'done' then return null; end if;
    v_pid := new.id; v_centre := n->>'center';
    -- the centre answered (accept / refuse / propose) -> tell the team
    if (n->'centreReply'->>'at') is not null and (n->'centreReply'->>'at') is distinct from (o->'centreReply'->>'at') then
      insert into centre_notify_queue(centre, patient_id, kind) values (v_centre, v_pid, 'reply');
    end if;
    -- dates / times changed on a patient already sent -> tell the centre (not on the send itself)
    if o is not null and centre_notify_visible(o) and o->'sentToCentre'->>'at' is not distinct from n->'sentToCentre'->>'at'
       and (o->>'arrival', o->>'departure', o->>'time', o->>'perWeek', o->'days', o->>'hours', o->>'mode')
           is distinct from (n->>'arrival', n->>'departure', n->>'time', n->>'perWeek', n->'days', n->>'hours', n->>'mode') then
      insert into centre_notify_queue(centre, patient_id, kind) values (v_centre, v_pid, 'change');
    end if;
  elsif coalesce(new.collection, old.collection) = 'sessions' then
    if tg_op = 'UPDATE' and (o->>'date', o->>'time', o->>'center', o->>'status' = 'cancelled')
         is not distinct from (n->>'date', n->>'time', n->>'center', n->>'status' = 'cancelled') then return null; end if;
    v_pid := coalesce(n->>'patientId', o->>'patientId');
    v_centre := coalesce(nullif(n->>'center',''), o->>'center');
    if v_pid is null or coalesce(v_centre,'') = '' then return null; end if;
    select data into p from records where collection = 'patients' and id = v_pid;
    if p is null or not centre_notify_visible(p) or p->>'center' <> v_centre or p->>'stage' = 'done' then return null; end if;
    -- sessions created within 10 minutes of sending are part of the send, not a change
    if (p->'sentToCentre'->>'at')::timestamptz > now() - interval '10 minutes' and tg_op = 'INSERT' then return null; end if;
    insert into centre_notify_queue(centre, patient_id, kind) values (v_centre, v_pid, 'change');
  end if;
  return null;
end $$;

-- wake the centre-portal function as soon as something is queued (same server key as the mail-sync trigger)
do $$ declare d text; begin
  if not exists (select 1 from pg_trigger where tgname = 'run_centre_notify_now') then
    select pg_get_triggerdef(t.oid) into d from pg_trigger t where t.tgname = 'run_mail_sync';
    if d is null then raise exception 'run_mail_sync trigger not found'; end if;
    d := replace(d, 'TRIGGER run_mail_sync', 'TRIGGER run_centre_notify_now');
    d := replace(d, 'ON public.mail_tick', 'ON public.centre_notify_queue');
    d := replace(d, '/functions/v1/mail-sync', '/functions/v1/centre-portal');
    if d not like '%ON public.centre_notify_queue%' then raise exception 'unexpected trigger definition'; end if;
    execute d;
  end if;
end $$;

-- the portal: only patients sent to this centre, and only their sessions
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

-- a centre may only answer for a patient that was sent to it
create or replace function public.portal_respond(p_patient_id text, p_action text, p_note text default '', p_times jsonb default '[]'::jsonb)
returns json language plpgsql volatile security definer set search_path = public as $$
declare c record; reply jsonb; t jsonb;
begin
  select centre, email into c from public.centre_users where user_id = auth.uid() and status <> 'removed' limit 1;
  if c.centre is null then raise exception 'not a centre account'; end if;
  if p_action not in ('accept','refuse','propose') then raise exception 'unknown action'; end if;
  if not exists (select 1 from public.records where collection = 'patients' and id = p_patient_id
                 and data->>'center' = c.centre and data->'sentToCentre'->>'centre' = c.centre) then
    raise exception 'this patient is not booked at your centre';
  end if;
  reply := jsonb_build_object('action', p_action, 'note', left(coalesce(p_note,''), 1000), 'times', coalesce(p_times,'[]'::jsonb),
                              'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'by', c.email, 'seen', false);
  update public.records set data = data || jsonb_build_object('centreReply', reply), updated_at = now()
   where collection = 'patients' and id = p_patient_id;
  update public.records set data = data
      || jsonb_build_object('centreReply', reply - 'times' - 'seen')
      || case when p_action = 'accept' and data->>'status' = 'planned' then jsonb_build_object('status','confirmed') else '{}'::jsonb end,
      updated_at = now()
   where collection = 'sessions' and data->>'patientId' = p_patient_id and data->>'center' = c.centre;
  if p_action = 'propose' then
    for t in select * from jsonb_array_elements(coalesce(p_times,'[]'::jsonb)) loop
      update public.records set data = data || jsonb_build_object('proposed', jsonb_build_object('date', t->>'date', 'time', t->>'time')), updated_at = now()
       where collection = 'sessions' and id = t->>'sessionId' and data->>'center' = c.centre;
    end loop;
  end if;
  return json_build_object('ok', true);
end $$;
