-- Tenant schemas must exist before migrating: this package never creates them.
CREATE SCHEMA IF NOT EXISTS tenant_001;
CREATE SCHEMA IF NOT EXISTS tenant_002;
CREATE TABLE IF NOT EXISTS tenant_001.orders (id serial PRIMARY KEY);
CREATE TABLE IF NOT EXISTS tenant_002.orders (id serial PRIMARY KEY);
