-- Run ONCE by an admin, not by the migration runner. Additive: a new role and a new schema, nothing else.
-- The caller passes a SCRAM verifier, never a plain password, so nothing secret reaches server logs:
--   psql -v ON_ERROR_STOP=1 -v verifier="SCRAM-SHA-256$..." -f db/bootstrap.sql
-- The role owns its schema and nothing else: no CREATE on the database, nosuperuser nobypassrls noinherit.
\set ON_ERROR_STOP on
create role lumbridge_app login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  connection limit 8 password :'verifier';
alter role lumbridge_app set search_path = lumbridge;
alter role lumbridge_app set statement_timeout = '15s';
alter role lumbridge_app set lock_timeout = '5s';
alter role lumbridge_app set idle_in_transaction_session_timeout = '30s';
-- Requires the admin to be able to SET ROLE lumbridge_app, which a superuser can.
create schema lumbridge authorization lumbridge_app;
revoke all on schema lumbridge from public;
