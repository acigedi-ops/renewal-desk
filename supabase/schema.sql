-- Renewal Desk database. Run once in Supabase: SQL Editor > New query > paste > Run.
-- One table mirrors the old artifact database: every document is (collection, id, data).

create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

alter table public.docs enable row level security;

-- Only signed-in users (Eduard, and anyone he adds in Authentication > Users) can see or change anything.
drop policy if exists "signed in users read"  on public.docs;
drop policy if exists "signed in users write" on public.docs;
create policy "signed in users read"  on public.docs for select to authenticated using (true);
create policy "signed in users write" on public.docs for all    to authenticated using (true) with check (true);

-- Merge fields into a document (like the old db "update"): top-level keys in patch replace the old ones.
create or replace function public.merge_doc(p_collection text, p_id text, p_patch jsonb)
returns jsonb language sql security invoker as $$
  insert into public.docs (collection, id, data, updated_at)
  values (p_collection, p_id, p_patch, now())
  on conflict (collection, id) do update
    set data = public.docs.data || excluded.data, updated_at = now()
  returning data;
$$;

-- Live updates in the browser.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- COI PDFs: private bucket, signed-in users only.
insert into storage.buckets (id, name, public) values ('cois', 'cois', false)
on conflict (id) do nothing;

drop policy if exists "signed in users read cois"   on storage.objects;
drop policy if exists "signed in users upload cois" on storage.objects;
create policy "signed in users read cois"   on storage.objects for select to authenticated using (bucket_id = 'cois');
create policy "signed in users upload cois" on storage.objects for insert to authenticated with check (bucket_id = 'cois');
