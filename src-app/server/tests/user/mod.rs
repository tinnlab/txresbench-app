//! User admin-list read-surface tests (billing-read-surface / #43).
//!
//! The admin `GET /api/users` gains a per-user `personal_account_id` (unconditional) and, under
//! saas, a `billing` sub-object populated ONLY for a `is_admin || billing::admin` caller. TEST-6 is
//! the non-saas leg (personal_account_id + the users::read gate) and runs in BOTH builds; TEST-7 is
//! the saas leg (billing visibility + the no-info-leak control) and compiles only with the feature.

mod user_list_read_test;
