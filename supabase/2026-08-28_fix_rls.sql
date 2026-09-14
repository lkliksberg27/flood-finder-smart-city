-- =====================================================================
-- SECURITY FIX  2026-08-28
--
-- The original schema created, on every table:
--
--   CREATE POLICY "Service role full access" ON <table>
--     FOR ALL USING (TRUE) WITH CHECK (TRUE);
--
-- A policy with no TO clause defaults to TO PUBLIC, which includes the
-- `anon` role. The anon key is embedded in the dashboard and mobile app
-- bundles and is readable by anyone, so in effect ANY visitor could
-- INSERT, UPDATE or DELETE every row in every table, including deleting
-- all devices and readings or injecting fake flood alerts.
--
-- The bridge writes with the SERVICE ROLE key, which bypasses RLS
-- entirely, so it never needed those policies. This drops them and
-- pins read access to the anon and authenticated roles.
--
-- Paste this whole file into the Supabase SQL editor and run it once.
-- =====================================================================

DROP POLICY IF EXISTS "Service role full access" ON devices;
DROP POLICY IF EXISTS "Service role full access" ON sensor_readings;
DROP POLICY IF EXISTS "Service role full access" ON flood_events;
DROP POLICY IF EXISTS "Service role full access" ON infrastructure_recommendations;

DROP POLICY IF EXISTS "Anon read access" ON devices;
DROP POLICY IF EXISTS "Anon read access" ON sensor_readings;
DROP POLICY IF EXISTS "Anon read access" ON flood_events;
DROP POLICY IF EXISTS "Anon read access" ON infrastructure_recommendations;

CREATE POLICY "Anon read access" ON devices
  FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "Anon read access" ON sensor_readings
  FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "Anon read access" ON flood_events
  FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "Anon read access" ON infrastructure_recommendations
  FOR SELECT TO anon, authenticated USING (TRUE);

-- Confirm the result: every row should be SELECT only, roles {anon,authenticated}.
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
