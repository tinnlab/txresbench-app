-- account module — the ACCOUNT-SCOPED member-management capability (#139,
-- epic #138) — SQLite dialect port (ITEM-10, sqlite-store) of
-- `src/modules/account/migrations/202609040001_account_members_manage.sql`.
--
-- Adds `account::members::manage` to the default `Users` group, turning
-- account self-service membership management ON by default. Revoking it here
-- turns it OFF deployment-wide: it is the operator kill switch named in
-- #139.
--
-- WHY A NEW KEY, not a grant of the existing `account::manage`, and why the
-- grant is not authority: see the Postgres file — `account::manage` keeps
-- its "(admin-only)" contract; authority is the caller's
-- `account_members.role` in the target account, resolved per-request by
-- `AccountScope<Min>` and refused with a 404 for a non-member
-- (`account_scope_test.rs` INV-3 pins it).
--
-- SQLite port note (ITEM-10, DEC-8): the `array_append` + `NOT (p = ANY
-- (permissions))` grant is the JSON1 form — `json_insert(permissions,
-- '$[#]', p)` guarded by a `json_each` membership check (the
-- `groups.permissions` text[] is JSON-array text; the ITEM-8/9 grant
-- idiom). Idempotent exactly as the Postgres file.
--
-- Ordering: prefix 202609040001 sorts above the app's current global max
-- (202609020020, sandbox) and far above the txresbench-auth schema+seed, so
-- `groups` and the `Users` row exist when this applies.

UPDATE groups
   SET permissions = json_insert(permissions, '$[#]', 'account::members::manage')
 WHERE name = 'Users'
   AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'account::members::manage');
