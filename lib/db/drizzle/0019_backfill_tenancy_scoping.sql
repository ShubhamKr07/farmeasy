-- Backfills the nullable facility_id/organization_id columns added in 0018
-- against the single pre-existing pilot facility/organization (already
-- guaranteed to exist by 0015's backfill + 0016's default-facility fix).
-- Same "first row wins" pattern as 0015 — there has only ever been one
-- facility/organization in the pilot data, so this is unambiguous.

UPDATE cycles SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE inventory_items SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE alerts SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE tasks SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE shipments SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE facility_logs SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE sensors SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE growth_profiles SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
  WHERE organization_id IS NULL;

UPDATE accounting_connections SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
  WHERE organization_id IS NULL;
