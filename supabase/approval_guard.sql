-- Renewal Desk: only Eduard can see the data, and nothing goes to a client without his own tap.
-- Run once in Supabase: SQL Editor > New query > paste all of this > Run. Safe to run again.
--
-- 1. Only Eduard's account (acigedi@gmail.com) can read or change anything, even if someone else signs up.
-- 2. A text becomes "approved" (which is what makes his Mac send it) only from the website, signed in as Eduard.
--    Routines (secret key), the Mac helper and anything else are refused by the database itself.
-- 3. Once a text is approved, or an email is being sent, its words and recipient can't change underneath the approval.
-- 4. Routines (secret key) can never mark an email or text as sending or sent: they can only write drafts.

-- ---------- 1. Eduard only ----------
create or replace function public.rd_is_eduard() returns boolean language sql stable as $$
  select auth.uid() = 'ee17d28b-1056-41f4-8117-a38149cdc464'::uuid
$$;

drop policy if exists "signed in users read"  on public.docs;
drop policy if exists "signed in users write" on public.docs;
drop policy if exists "eduard reads"  on public.docs;
drop policy if exists "eduard writes" on public.docs;
create policy "eduard reads"  on public.docs for select to authenticated using (public.rd_is_eduard());
create policy "eduard writes" on public.docs for all    to authenticated using (public.rd_is_eduard()) with check (public.rd_is_eduard());

drop policy if exists "signed in users read cois"   on storage.objects;
drop policy if exists "signed in users upload cois" on storage.objects;
drop policy if exists "eduard reads cois"   on storage.objects;
drop policy if exists "eduard uploads cois" on storage.objects;
create policy "eduard reads cois"   on storage.objects for select to authenticated using (bucket_id = 'cois' and public.rd_is_eduard());
create policy "eduard uploads cois" on storage.objects for insert to authenticated with check (bucket_id = 'cois' and public.rd_is_eduard());

-- ---------- 2-4. Send guard ----------
create or replace function public.rd_send_guard() returns trigger language plpgsql as $$
declare
  old_s text := case when tg_op = 'UPDATE' then coalesce(old.data->>'status', '') else '' end;
  new_s text := coalesce(new.data->>'status', '');
  role  text := coalesce(auth.role(), current_user);
  -- The website talks to the database through supabase-js, which labels every request; the Mac helper uses curl.
  from_site boolean := coalesce(current_setting('request.headers', true)::json->>'x-client-info', '') like 'supabase-js%';
begin
  if new.collection = 'texts' then
    if new_s = 'approved' and old_s <> 'approved' and not (role = 'authenticated' and public.rd_is_eduard() and from_site) then
      raise exception 'Only Eduard can approve a text, by tapping Approve & send on the website';
    end if;
    if new_s = 'approved' and length(regexp_replace(coalesce(new.data->>'phone', ''), '\D', '', 'g')) not in (10, 11) then
      raise exception 'A text can only be approved for one phone number';
    end if;
    if new_s = 'sending' and old_s not in ('approved', 'sending') then
      raise exception 'A text can only be sent after Eduard approves it';
    end if;
    if old_s in ('approved', 'sending') and new_s in ('approved', 'sending')
       and (new.data->'body' is distinct from old.data->'body' or new.data->'phone' is distinct from old.data->'phone'
            or new.data->'client_id' is distinct from old.data->'client_id') then
      raise exception 'This text is already approved: put it back to draft before changing it';
    end if;
  elsif new.collection = 'outbox' then
    if old_s = 'sending' and new_s = 'sending'
       and (new.data->'to' is distinct from old.data->'to' or new.data->'cc' is distinct from old.data->'cc'
            or new.data->'subject' is distinct from old.data->'subject' or new.data->'body' is distinct from old.data->'body'
            or new.data->'attachments' is distinct from old.data->'attachments') then
      raise exception 'This email is being sent and can''t change now';
    end if;
  end if;
  if new.collection in ('texts', 'outbox') and role <> 'authenticated' and new_s in ('approved', 'sending', 'sent', 'unsure')
     and old_s is distinct from new_s then
    raise exception 'Routines can only write drafts: only Eduard''s Approve & send sends an email or text';
  end if;
  return new;
end $$;

drop trigger if exists rd_send_guard on public.docs;
create trigger rd_send_guard before insert or update on public.docs
  for each row when (new.collection in ('texts', 'outbox')) execute function public.rd_send_guard();
