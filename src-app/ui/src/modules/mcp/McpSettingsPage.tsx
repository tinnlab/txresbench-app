import { ErrorState, Spin } from '@txresbench/kit'
import { SettingsPageContainer } from '@txresbench/shell'
import { McpSettings } from '@/modules/mcp/stores/McpSettings.store'
import { McpLimitsCard } from '@/modules/mcp/components/McpLimitsCard'

const SUBTITLE =
  'The AI-controllable-actions MCP surface. Set the agent caps (concurrent control ' +
  'sessions, in-flight invokes, per-action wall-clock), the one-time pairing-code ' +
  'TTL, and the tool result caps every AI request is bounded by.'

/**
 * Admin "MCP" settings page — agent/tool caps + pairing-TTL (editable,
 * permission-gated). Route + slot are gated on `mcp::settings::read`, so an
 * unpermitted user never reaches here. Mirrors `WorkstoreSettingsPage`.
 */
export default function McpSettingsPage() {
  const { settings, loading, error } = McpSettings

  if (loading && !settings) {
    return (
      <SettingsPageContainer title="MCP" subtitle={SUBTITLE}>
        <div className="flex justify-center py-12">
          <Spin size="lg" label="Loading MCP settings" />
        </div>
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer title="MCP" subtitle={SUBTITLE}>
      <div data-testid="mcp-settings-page" className="flex flex-col gap-4">
        {error && !settings ? (
          <ErrorState
            variant="page"
            resource="MCP settings"
            description="The MCP settings couldn't be loaded. Check your connection and try again."
            details={error}
            onRetry={() => void McpSettings.loadSettings()}
            data-testid="mcp-settings-error"
          />
        ) : (
          <McpLimitsCard />
        )}
      </div>
    </SettingsPageContainer>
  )
}
