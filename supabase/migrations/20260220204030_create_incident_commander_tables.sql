create table services (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  description text,
  owner text,
  team text,
  tier int not null check (tier in (1, 2, 3)),
  dependencies text[] default '{}',
  created_at timestamptz default now()
);

create table incidents (
  id uuid default gen_random_uuid() primary key,
  service_name text not null references services(name) on update cascade,
  title text not null,
  severity text not null check (severity in ('P1', 'P2', 'P3')),
  root_cause text,
  resolution text,
  duration_minutes int,
  occurred_at timestamptz not null default now(),
  created_at timestamptz default now()
);

create table deployments (
  id uuid default gen_random_uuid() primary key,
  service_name text not null references services(name) on update cascade,
  version text not null,
  deployed_by text,
  description text,
  status text not null check (status in ('success', 'failed', 'rolled_back')),
  deployed_at timestamptz not null default now(),
  created_at timestamptz default now()
);

create table runbooks (
  id uuid default gen_random_uuid() primary key,
  service_name text not null references services(name) on update cascade,
  scenario text not null,
  steps text not null,
  created_at timestamptz default now()
);

alter table services enable row level security;
alter table incidents enable row level security;
alter table deployments enable row level security;
alter table runbooks enable row level security;
