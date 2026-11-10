-- Script Modernizer schema. Sanitized content only.
-- Row Level Security is ON for every table and NO policies are created,
-- so the publishable key grants nothing. The server connects with the
-- pooled Postgres connection string (table owner), which bypasses RLS.

create table if not exists runs (
  id          text primary key,
  state       text not null,
  script_type text not null,
  platform    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  data        jsonb not null
);
create index if not exists runs_created_idx on runs (created_at desc);

create table if not exists feedback (
  id         text primary key,
  run_id     text not null references runs (id) on delete cascade,
  rating     integer check (rating between 1 and 5),
  comment    text,
  error_code text,
  line       integer,
  at         timestamptz not null default now()
);
create index if not exists feedback_at_idx on feedback (at desc);

create table if not exists app_logs (
  id     bigint generated always as identity primary key,
  ts     timestamptz not null default now(),
  level  text not null,
  run_id text,
  stage  text,
  msg    text not null,
  data   jsonb not null default '{}'::jsonb
);
create index if not exists app_logs_ts_idx on app_logs (ts);

create table if not exists skill_rules (
  id         text primary key,
  platform   text not null,
  status     text not null,
  version    integer not null default 1,
  indexed    boolean not null default false,
  updated_at timestamptz not null default now(),
  data       jsonb not null
);
create index if not exists skill_rules_status_idx on skill_rules (platform, status);

create table if not exists conversion_examples (
  run_id     text primary key,
  platform   text not null,
  indexed    boolean not null default false,
  created_at timestamptz not null default now(),
  data       jsonb not null
);

create table if not exists rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

alter table runs                enable row level security;
alter table feedback            enable row level security;
alter table app_logs            enable row level security;
alter table skill_rules         enable row level security;
alter table conversion_examples enable row level security;
alter table rate_limits         enable row level security;
