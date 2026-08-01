INSERT INTO organizations (name) VALUES ('Default Organization')
  ON CONFLICT DO NOTHING;
UPDATE facilities SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
  WHERE organization_id IS NULL;
UPDATE rooms SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

-- NOT in the plan's §2.1 step-3 SQL verbatim. Added because db:generate's diff showed
-- facilities.facility_name and facilities.timezone as new NOT NULL columns with no
-- default -- the same class of ordering bug as organization_id/facility_id above.
-- Backfilling with a reasonable placeholder so 0016's SET NOT NULL doesn't fail against
-- the existing seeded facility row. Flagged in task-1-report.md for plan-author review.
UPDATE facilities SET facility_name = name WHERE facility_name IS NULL;
UPDATE facilities SET timezone = 'UTC' WHERE timezone IS NULL;
