-- account module — the ACCOUNT-SCOPED member-management capability (#139, epic #138).
--
-- Adds `account::members::manage` to the default `Users` group, turning account
-- self-service membership management ON by default. Revoking it here turns it OFF
-- deployment-wide: it is the operator kill switch named in #139.
--
-- WHY A NEW KEY, and not a grant of the existing `account::manage`:
-- granting `account::manage` to Users would in ONE step (a) open `POST /api/accounts`
-- to every user with an attacker-chosen `owner_id`, (b) universally satisfy the
-- permission factor on the three `/api/admin/accounts/*` member-CRUD routes, reducing
-- them to single-factor defence, and (c) make the FE's `admin.account.*` actions
-- (permissioned on `Permissions.AccountManage`, `surfaces.ai: true`) visible and
-- MCP-invocable for everyone. `account::manage` therefore keeps its "(admin-only)"
-- contract and stays granted to NO group.
--
-- THE GRANT IS NOT AUTHORITY. Holding this key lets a principal reach an
-- account-scoped route; it does not tell the server WHICH account. Authority is the
-- caller's `account_members.role` in the TARGET account, resolved per-request by
-- `AccountScope<Min>` (`modules/account/member_scope.rs`) and refused with a 404 for a
-- non-member. So this blanket Users-group grant confers nothing on its own — that is
-- the property `account_scope_test.rs` INV-3 pins.
--
-- Ordering: prefix 202609040001 sorts above the app's current global max
-- (202609020020, sandbox) and far above the ziee-auth schema+seed, so `groups` and the
-- `Users` row exist when this applies. Migrations on this tree are PER-MODULE
-- (`modules/<mod>/migrations/`); there is no top-level `src-app/server/migrations`.

-- Idempotent, matching the `account::read` grant in 202608040012_account_baseline.sql:
-- append only when absent, so a re-run is a no-op and cannot duplicate the entry.
UPDATE public.groups
SET permissions = array_append(permissions, 'account::members::manage')
WHERE name = 'Users'
  AND NOT ('account::members::manage' = ANY (permissions));
