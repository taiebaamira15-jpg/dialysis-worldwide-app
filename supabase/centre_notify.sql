-- Dialysis Worldwide – email partner centres about new patients and date/time changes.
-- 1) changes to patients/sessions are queued here by a trigger
-- 2) every 5 minutes (same cron tick as mail-sync) the centre-portal function sends grouped emails.

create table if not exists public.centre_notify_queue (
  id         bigserial primary key,
  centre     text not null,
  patient_id text not null,
  kind       text not null,              -- 'new' | 'change'
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
alter table public.centre_notify_queue enable row level security;   -- no policies: only the server function reads it
create index if not exists centre_notify_pending on public.centre_notify_queue (created_at) where sent_at is null;

create or replace function public.centre_notify_visible(d jsonb)
returns boolean language sql immutable as $$
  select coalesce(d->>'center','') <> '' and coalesce(d->>'stage','') in ('docs','quote','confirmed','treatment','done')
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
    if o is null or not centre_notify_visible(o) or o->>'center' is distinct from n->>'center' then
      insert into centre_notify_queue(centre, patient_id, kind) select v_centre, v_pid, 'new'
        where exists (select 1 from centre_users where centre_users.centre = v_centre and status <> 'removed');
    elsif (o->>'arrival', o->>'departure', o->>'time', o->>'perWeek', o->'days', o->>'hours', o->>'mode')
          is distinct from (n->>'arrival', n->>'departure', n->>'time', n->>'perWeek', n->'days', n->>'hours', n->>'mode') then
      insert into centre_notify_queue(centre, patient_id, kind) select v_centre, v_pid, 'change'
        where exists (select 1 from centre_users where centre_users.centre = v_centre and status <> 'removed');
    end if;
  elsif coalesce(new.collection, old.collection) = 'sessions' then
    -- a session added, removed, moved, or cancelled
    if tg_op = 'UPDATE' and (o->>'date', o->>'time', o->>'center', o->>'status' = 'cancelled')
         is not distinct from (n->>'date', n->>'time', n->>'center', n->>'status' = 'cancelled') then return null; end if;
    v_pid := coalesce(n->>'patientId', o->>'patientId');
    v_centre := coalesce(nullif(n->>'center',''), o->>'center');
    if v_pid is null or coalesce(v_centre,'') = '' then return null; end if;
    select data into p from records where collection = 'patients' and id = v_pid;
    if p is null or not centre_notify_visible(p) or p->>'center' <> v_centre or p->>'stage' = 'done' then return null; end if;
    insert into centre_notify_queue(centre, patient_id, kind) select v_centre, v_pid, 'change'
      where exists (select 1 from centre_users where centre_users.centre = v_centre and status <> 'removed');
  end if;
  return null;
end $$;

drop trigger if exists centre_notify on public.records;
create trigger centre_notify after insert or update or delete on public.records
  for each row execute function public.centre_notify_enqueue();

-- every cron tick (every 5 min) also wakes the centre-portal function, with the same server key the mail-sync trigger uses
do $$ declare d text; begin
  if not exists (select 1 from pg_trigger where tgname = 'run_centre_notify') then
    select pg_get_triggerdef(t.oid) into d from pg_trigger t where t.tgname = 'run_mail_sync';
    if d is null then raise exception 'run_mail_sync trigger not found'; end if;
    d := replace(d, 'TRIGGER run_mail_sync', 'TRIGGER run_centre_notify');
    d := replace(d, '/functions/v1/mail-sync', '/functions/v1/centre-portal');
    execute d;
  end if;
end $$;
