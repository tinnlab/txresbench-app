//! Tool implementations dispatched by the txresbench server's
//! `handlers::jsonrpc_handler`. The engine owns `execute` (the sandboxed
//! `execute_command` path incl. the pure per-OS `apply_workspace_mode` chmod);
//! `files` stays in the txresbench server crate (DB-backed workspace file ops).

pub mod execute;
