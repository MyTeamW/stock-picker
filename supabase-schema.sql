create table if not exists public.picker_stocks (
  code text primary key,
  name text not null,
  remark text default '',
  business text default '',
  price numeric,
  high numeric,
  low numeric,
  open numeric,
  previous_close numeric,
  change_amount numeric,
  change_percent numeric,
  volume numeric,
  turnover numeric,
  quote_date text,
  refreshed_at timestamptz,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists picker_stocks_active_idx
on public.picker_stocks (deleted, created_at desc, code asc);

create table if not exists public.picker_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.picker_results (
  trade_date date primary key,
  generated_at timestamptz not null default now(),
  title text not null,
  summary text not null,
  rationale jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  action text default '',
  prompt text default '',
  candidate_code text,
  candidate_name text,
  source_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists picker_results_active_idx
on public.picker_results (active, generated_at desc);

alter table public.picker_stocks enable row level security;
alter table public.picker_settings enable row level security;
alter table public.picker_results enable row level security;

drop policy if exists "public read picker stocks" on public.picker_stocks;
drop policy if exists "public insert picker stocks" on public.picker_stocks;
drop policy if exists "public update picker stocks" on public.picker_stocks;

create policy "public read picker stocks"
on public.picker_stocks for select
using (true);

create policy "public insert picker stocks"
on public.picker_stocks for insert
with check (true);

create policy "public update picker stocks"
on public.picker_stocks for update
using (true)
with check (true);

drop policy if exists "public read picker settings" on public.picker_settings;
drop policy if exists "public insert picker settings" on public.picker_settings;
drop policy if exists "public update picker settings" on public.picker_settings;

create policy "public read picker settings"
on public.picker_settings for select
using (true);

create policy "public insert picker settings"
on public.picker_settings for insert
with check (true);

create policy "public update picker settings"
on public.picker_settings for update
using (true)
with check (true);

drop policy if exists "public read picker results" on public.picker_results;
drop policy if exists "public insert picker results" on public.picker_results;
drop policy if exists "public update picker results" on public.picker_results;

create policy "public read picker results"
on public.picker_results for select
using (true);

create policy "public insert picker results"
on public.picker_results for insert
with check (true);

create policy "public update picker results"
on public.picker_results for update
using (true)
with check (true);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists picker_stocks_set_updated_at on public.picker_stocks;
create trigger picker_stocks_set_updated_at
before update on public.picker_stocks
for each row
execute function public.set_updated_at();

drop trigger if exists picker_settings_set_updated_at on public.picker_settings;
create trigger picker_settings_set_updated_at
before update on public.picker_settings
for each row
execute function public.set_updated_at();

drop trigger if exists picker_results_set_updated_at on public.picker_results;
create trigger picker_results_set_updated_at
before update on public.picker_results
for each row
execute function public.set_updated_at();

insert into public.picker_settings (key, value)
values ('default', '{"minPrice":0,"maxPrice":70,"pickTime":"14:30","lot":1}'::jsonb)
on conflict (key) do update
set value = public.picker_settings.value || '{"pickTime":"14:30"}'::jsonb;
