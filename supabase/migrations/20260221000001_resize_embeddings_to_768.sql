-- Resize embedding columns from 1024 (voyage-3) to 768 (Gemini text-embedding-004)
-- Safe to do now because all values are still NULL (server never ran embeddings)

drop index if exists services_embedding_idx;
drop index if exists incidents_embedding_idx;

alter table services  alter column embedding type vector(768);
alter table incidents alter column embedding type vector(768);

-- Recreate HNSW indexes for the new dimension
create index services_embedding_idx  on services  using hnsw (embedding vector_cosine_ops);
create index incidents_embedding_idx on incidents using hnsw (embedding vector_cosine_ops);

-- Recreate RPCs with vector(768)
create or replace function match_services(
  query_embedding vector(768),
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

create or replace function match_incidents(
  query_embedding vector(768),
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
