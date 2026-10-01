-- Runs once as the postgres superuser on database "nais" (docker-entrypoint-initdb.d, and the test fixture).
-- Dev passwords are "nais" per owner decision (D-037); production overrides them via secrets (D-027).
CREATE ROLE nais_migrator LOGIN PASSWORD 'nais';
CREATE ROLE nais_app LOGIN PASSWORD 'nais';
GRANT CONNECT, CREATE ON DATABASE nais TO nais_migrator;
GRANT CONNECT ON DATABASE nais TO nais_app;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['platform','identity','project','catalog','governance','readiness','audit',
                           'marketplace','compute','knowledge','autonomy'] LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION nais_migrator', s);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO nais_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA %I '
                   'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nais_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE nais_migrator IN SCHEMA %I '
                   'GRANT USAGE, SELECT ON SEQUENCES TO nais_app', s);
  END LOOP;
END $$;

-- W1-D2: trigram search for module migrations (public.gin_trgm_ops, public.similarity). Installed once here, as
-- superuser; module migrations never CREATE EXTENSION.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
