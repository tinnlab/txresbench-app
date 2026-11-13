// AUTO-GENERATED — do not edit. Regenerate with `just openapi-regen`.
// Human-readable permission labels, split out of `types.ts` so they load only
// where used (the permission picker) instead of on every page.

export const PermissionDescriptions: Record<string, string> = {
  AccountManage: 'Create and manage organizations and their members',
  AccountMembersManage: 'Manage the members of accounts you administer',
  AccountRead: 'View your accounts and their membership',
  AuthProvidersManage: 'Create, update, delete, enable/disable, and test auth providers.',
  AuthProvidersRead: 'List configured auth providers and view their (masked) config.',
  FeaturesManage: 'List and set runtime feature flags (global defaults + per-account overrides)',
  FilesDelete: 'Delete files',
  FilesDownload: 'Download file content',
  FilesGenerateToken: 'Generate download tokens',
  FilesPreview: 'View file thumbnails and previews',
  FilesRead: 'View file metadata and list files',
  FilesUpload: 'Upload new files',
  JobsUse: 'Create, view, and stop your own analysis jobs',
  McpSettingsManage: 'Change the MCP agent/tool caps and pairing-code TTL',
  McpSettingsRead: 'View the MCP agent/tool caps and pairing-code TTL',
  McpUse: 'Let an external AI assistant (e.g. txresbench chat) operate TxResBench on your behalf.',
  NotificationsRead: 'Read and manage your own notifications.',
  ProfileEdit: 'Edit own profile information',
  ProfileRead: 'View own profile information',
  ProjectsUse: 'Create, view, and manage your projects',
  SandboxExecute: 'Run an analysis job in the sandbox',
  SandboxSettingsManage: 'Change sandbox resource limits',
  SandboxSettingsRead: 'View sandbox resource limits and rootfs status',
  SessionSettingsManage: 'Update session settings (access-token TTL + max session length).',
  SessionSettingsRead: 'Read session settings (access-token TTL + max session length).'
}
