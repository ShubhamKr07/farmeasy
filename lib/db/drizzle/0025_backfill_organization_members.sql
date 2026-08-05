-- organization_members has been empty since MT-M0 created it (Task 1) --
-- nothing ever backfilled it or wrote to it. This backfills every existing
-- user (identified by users.organization_id, the now-deprecated column) into
-- organization_members as "owner" -- there is no admin/technician
-- distinction possible yet, since team invites (TEN-010) don't exist until
-- MT-M2. ON CONFLICT DO NOTHING makes this safe to re-run (the unique index
-- on user_id would otherwise raise on a second run).
INSERT INTO organization_members (organization_id, user_id, role, status)
SELECT organization_id, id, 'owner', 'active'
FROM users
WHERE organization_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
