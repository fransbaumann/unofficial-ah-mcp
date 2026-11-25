-- Tabellen voor de cloudversie (één AH-account per deployment).
create table if not exists public.ah_auth_state (
  id smallint primary key default 1 check (id = 1),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ah_mcp_config (
  id smallint primary key default 1 check (id = 1),
  mcp_key text not null
);

-- Geen policies: alleen de service role (Edge Function) mag erbij.
alter table public.ah_auth_state enable row level security;
alter table public.ah_mcp_config enable row level security;
