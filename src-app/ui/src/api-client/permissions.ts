// AUTO-GENERATED — do not edit. Regenerate with `just openapi-regen`.
// The `Permissions` enum, split out of `types.ts` so it isn't pinned to the
// eager entry chunk (value uses are inlined at build; only the lazy picker
// enumerates the object).

export enum Permissions {
  AccountManage = 'account::manage',
  AccountMembersManage = 'account::members::manage',
  AccountRead = 'account::read',
  AuthProvidersManage = 'auth_providers::manage',
  AuthProvidersRead = 'auth_providers::read',
  FeaturesManage = 'features::manage',
  FilesDelete = 'files::delete',
  FilesDownload = 'files::download',
  FilesGenerateToken = 'files::generate_token',
  FilesPreview = 'files::preview',
  FilesRead = 'files::read',
  FilesUpload = 'files::upload',
  JobsUse = 'jobs::use',
  McpSettingsManage = 'mcp::settings::manage',
  McpSettingsRead = 'mcp::settings::read',
  McpUse = 'mcp::use',
  NotificationsRead = 'notifications::read',
  ProfileEdit = 'profile::edit',
  ProfileRead = 'profile::read',
  ProjectsUse = 'projects::use',
  SandboxExecute = 'sandbox::execute',
  SandboxSettingsManage = 'sandbox::settings::manage',
  SandboxSettingsRead = 'sandbox::settings::read',
  SessionSettingsManage = 'auth::session_settings::manage',
  SessionSettingsRead = 'auth::session_settings::read'
}
