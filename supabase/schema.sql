-- Junk Drawer schema. See PLAN.md §2 and link-box-spec.md §3.2.
-- Run once in the Supabase SQL editor.

create table if not exists links (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  note          text,
  title         text,
  description   text,
  image_url     text,
  domain        text,
  tags          text[] not null default '{}',
  status        text   not null default 'unread' check (status in ('unread', 'done')),
  imdb_rating   text,
  trailer_url   text,

  -- Capture returns before enrichment finishes, so a row can exist with no
  -- title. Without this the UI can't tell "still working" from "permanently
  -- thin", and a Gemini outage leaves untitled rows with no trace.
  type          text   not null default 'link'    check (type in ('link', 'screenshot')),
  enrichment    text   not null default 'pending' check (enrichment in ('pending', 'ok', 'failed')),
  enrich_error  text,

  created_at    timestamptz not null default now()
);

-- Capture upserts on url so re-sharing the same link updates rather than
-- creating a duplicate row.
create unique index if not exists links_url_key on links (url);

create index if not exists links_created_idx on links (created_at desc);
create index if not exists links_status_idx  on links (status);
create index if not exists links_tags_idx    on links using gin (tags);

-- No RLS policies: the app never touches this table from the browser. All
-- access goes through the server using the service-role key.
alter table links enable row level security;
