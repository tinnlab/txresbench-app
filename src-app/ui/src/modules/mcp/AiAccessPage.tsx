import { Bot, Copy, RefreshCw } from 'lucide-react'
import { Alert, Button, Card, Input, Paragraph, Tag, message } from '@txresbench/kit'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@txresbench/kit/shadcn/field'
import { SettingsPageContainer } from '@txresbench/shell'
import { McpConnect } from '@/modules/mcp/stores/McpConnect.store'
import { isDesktop } from '@/core/platform'
import { type ConnectionStatus, useConnectionStatus } from '@/core/actions/engine'

const SUBTITLE =
  'Connect an external AI assistant (e.g. txresbench chat) to operate TxResBench on your behalf — ' +
  'open projects, run analyses, and drive the app while you watch.'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  stopped: 'Not connected',
}

const STATUS_TONE: Record<ConnectionStatus, 'default' | 'success' | 'warning'> = {
  idle: 'default',
  connecting: 'warning',
  connected: 'success',
  reconnecting: 'warning',
  stopped: 'default',
}

function ConnectionStatusTag({ status }: { status: ConnectionStatus }) {
  return (
    <Tag
      tone={STATUS_TONE[status]}
      data-testid="ai-access-connection-status"
      role="status"
      aria-live="polite"
    >
      {STATUS_LABEL[status]}
    </Tag>
  )
}

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    message.success(`${label} copied to clipboard`)
  } catch {
    message.error(`Couldn't copy the ${label.toLowerCase()} — copy it manually`)
  }
}

/** Best-effort OS-level deep link into txresbench (desktop only). The manual
 *  code/URL copy below is the always-available fallback — this is purely
 *  a convenience shortcut when it works. */
function attemptDeepLink(code: string, mcpUrl: string) {
  const deepLink = `txresbench://connect-mcp?code=${encodeURIComponent(code)}&url=${encodeURIComponent(mcpUrl)}&name=TxResBench`
  try {
    window.location.href = deepLink
  } catch {
    // best-effort only — the copyable code/URL below always works.
  }
}

/**
 * "AI Assistant Access" settings page (PLAN.md ITEM-17; mirrors
 * `SandboxSettingsPage`). Mints a one-time pairing code + MCP server URL
 * (`POST /api/mcp/pair/start`) that the user hands to txresbench — either via a
 * best-effort desktop deep link or by copying the code/URL manually. The
 * code is exchanged by txresbench itself (`pair/exchange`), never by this page.
 * Live connection status comes from the frontend agent engine
 * (`@/core/actions/engine`), started/stopped by `modules/actions` based on
 * auth + `mcp::use`.
 */
export default function AiAccessPage() {
  const { code, mcpUrl, starting, error } = McpConnect
  const status = useConnectionStatus()

  const paired = Boolean(code && mcpUrl)

  return (
    <SettingsPageContainer title="AI Assistant Access" subtitle={SUBTITLE}>
      <div data-testid="ai-access-page" className="flex flex-col gap-4">
        <Card
          data-testid="ai-access-connect-card"
          title="Connect to txresbench"
          extra={<ConnectionStatusTag status={status} />}
        >
          <Paragraph className="mb-3 text-sm text-muted-foreground">
            Click connect to mint a one-time pairing code, then add it in txresbench as an MCP server. Once
            paired, your assistant can drive TxResBench as you — every change it makes shows up live
            in this app.
          </Paragraph>

          {error && (
            <Alert
              data-testid="ai-access-error"
              tone="error"
              title="Couldn't start pairing"
              description={error}
              className="mb-3"
            />
          )}

          {!paired ? (
            <Button
              data-testid="ai-access-connect-start"
              onClick={() => void McpConnect.startPairing()}
              loading={starting}
            >
              <Bot className="mr-1 size-4" />
              Connect to txresbench
            </Button>
          ) : (
            <div className="flex flex-col gap-4">
              <Alert
                data-testid="ai-access-instructions"
                tone="info"
                title="Finish the connection in txresbench"
                description="In txresbench, add an MCP server with the URL below, then enter the pairing code when prompted. The code is single-use and expires shortly."
              />

              <FieldGroup>
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor="ai-access-mcp-url">Server URL</FieldLabel>
                    <FieldDescription>The MCP server address to add in txresbench.</FieldDescription>
                  </FieldContent>
                  <div className="flex items-center gap-2">
                    <Input
                      id="ai-access-mcp-url"
                      data-testid="ai-access-mcp-url"
                      readOnly
                      value={mcpUrl ?? ''}
                      className="font-mono text-xs"
                      onFocus={e => e.currentTarget.select()}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      tooltip="Copy server URL"
                      data-testid="ai-access-copy-url"
                      onClick={() => void copyToClipboard(mcpUrl ?? '', 'Server URL')}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </Field>
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor="ai-access-mcp-code">Pairing code</FieldLabel>
                    <FieldDescription>Enter this code in txresbench when prompted.</FieldDescription>
                  </FieldContent>
                  <div className="flex items-center gap-2">
                    <Input
                      id="ai-access-mcp-code"
                      data-testid="ai-access-mcp-code"
                      readOnly
                      value={code ?? ''}
                      className="font-mono text-xs"
                      onFocus={e => e.currentTarget.select()}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      tooltip="Copy pairing code"
                      data-testid="ai-access-copy-code"
                      onClick={() => void copyToClipboard(code ?? '', 'Pairing code')}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </Field>
              </FieldGroup>

              <div className="flex flex-wrap items-center gap-2">
                {isDesktop() && (
                  <Button
                    variant="outline"
                    data-testid="ai-access-open-txresbench"
                    onClick={() => attemptDeepLink(code ?? '', mcpUrl ?? '')}
                  >
                    Open in txresbench
                  </Button>
                )}
                <Button
                  variant="ghost"
                  data-testid="ai-access-regenerate"
                  loading={starting}
                  onClick={() => void McpConnect.startPairing()}
                >
                  <RefreshCw className="mr-1 size-4" />
                  Generate a new code
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </SettingsPageContainer>
  )
}
