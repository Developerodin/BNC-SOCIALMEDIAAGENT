-- Local docker only (runs on first init of an empty volume); never runs in production.
-- Roles are cluster-wide, so this also covers the shopassist_test database.
CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS;
