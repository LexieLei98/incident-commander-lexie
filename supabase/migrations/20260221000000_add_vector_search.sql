-- Enable pgvector extension
create extension if not exists vector;

-- Add 1024-dimensional embedding columns (voyage-3 output size)
alter table services add column if not exists embedding vector(1024);
alter table incidents add column if not exists embedding vector(1024);

-- HNSW indexes for fast approximate nearest-neighbour search
create index if not exists services_embedding_idx
  on services using hnsw (embedding vector_cosine_ops);

create index if not exists incidents_embedding_idx
  on incidents using hnsw (embedding vector_cosine_ops);

-- RPC: semantic search over the services catalogue
create or replace function match_services(
  query_embedding vector(1024),
  match_count      int default 3
)
returns table (
  id           uuid,
  name         text,
  description  text,
  owner        text,
  team         text,
  tier         int,
  dependencies text[],
  created_at   timestamptz,
  similarity   float8
)
language sql stable
as $$
  select
    s.id,
    s.name,
    s.description,
    s.owner,
    s.team,
    s.tier,
    s.dependencies,
    s.created_at,
    1 - (s.embedding <=> query_embedding) as similarity
  from services s
  where s.embedding is not null
  order by s.embedding <=> query_embedding
  limit match_count;
$$;

-- RPC: semantic search over historical incidents
create or replace function match_incidents(
  query_embedding vector(1024),
  match_count      int default 5
)
returns table (
  id               uuid,
  service_name     text,
  title            text,
  severity         text,
  root_cause       text,
  resolution       text,
  duration_minutes int,
  occurred_at      timestamptz,
  created_at       timestamptz,
  similarity       float8
)
language sql stable
as $$
  select
    i.id,
    i.service_name,
    i.title,
    i.severity,
    i.root_cause,
    i.resolution,
    i.duration_minutes,
    i.occurred_at,
    i.created_at,
    1 - (i.embedding <=> query_embedding) as similarity
  from incidents i
  where i.embedding is not null
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
