import type { CSSProperties } from 'react'
import { Alert, Button, message } from '@txresbench/kit'
import type { AlertTone } from '@txresbench/kit'
import type { WslSetupResult } from '@/api-client/types'
import { runAction } from '@/core/actions/defineAction'
import { useAppMode } from '@/modules/demo'
import { useWslSetup, type WslSetupFacts } from '@/lib/wsl-setup/wslSetup'

/** What the notice says and offers (pure: the unit tests pin the words). */
export interface WslNoticeView {
  tone: AlertTone
  /** Why methods cannot run, or that WSL is set up. */
  title: string
  /** What is happening or what the last setup did; `null`: nothing to add. */
  status: string | null
  /** The last lines wsl.exe printed when a setup failed. */
  detail: string | null
  /** The button: its label and whether a setup is running. */
  button: { label: string; busy: boolean } | null
}

export const WSL_MISSING_LINE =
  'Methods cannot run yet: they run in WSL 2 (Windows Subsystem for Linux), which is not installed.'
export const WSL_OLD_LINE = 'Methods cannot run yet: the installed WSL is too old.'
export const WSL_RUNNING_LINE =
  'A WSL setup is running. It goes on after you confirm in the TxResBench dialog (Windows may also ask for permission); the download from Microsoft can take several minutes.'
export const WSL_ASKS_LINE =
  'TxResBench asks you to confirm in a dialog, and Windows may also ask for permission; WSL is downloaded from Microsoft.'
export const WSL_DONE_RESTART_LINE = 'WSL is set up. Restart Windows, then open TxResBench again to run methods.'
export const WSL_DONE_LINE = 'WSL is up to date. Close TxResBench and open it again to run methods.'
export const WSL_DECLINED_LINE = 'WSL was not set up: the setup was declined, so nothing was changed.'
export const WSL_AGAIN_SOON_LINE = 'It can be started again in a minute.'

/** An exit code the way Windows tools print it: an HRESULT in hex, a small code as is. */
export function formatExitCode(code: number): string {
  return code > 0xffff ? `0x${code.toString(16).toUpperCase().padStart(8, '0')}` : String(code)
}

/** A sentence from the server's words: a capital first letter and a full stop. */
function sentence(text: string): string {
  const t = text.trim()
  if (t === '') return t
  const capital = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

/** The line for the last setup's result (`done` has its own title). */
function resultLine(last: WslSetupResult): { status: string; detail: string | null; tone: AlertTone } {
  switch (last.outcome) {
    case 'declined':
      return { status: WSL_DECLINED_LINE, detail: null, tone: 'warning' }
    case 'not_started':
      return {
        status: `WSL setup could not start (Windows error ${last.windows_error ?? 'unknown'}).`,
        detail: null,
        tone: 'error',
      }
    default: {
      const code = last.exit_code === undefined ? '' : ` (code ${formatExitCode(last.exit_code)})`
      return {
        status: `WSL could not be set up${code}. Check the internet connection and try again.`,
        detail: last.output.trim() === '' ? null : last.output,
        tone: 'error',
      }
    }
  }
}

export function wslNoticeView(facts: WslSetupFacts, posting: boolean): WslNoticeView {
  const { setup } = facts
  const last = setup.last
  if (last?.outcome === 'done') {
    return {
      tone: 'success',
      title: last.restart_windows ? WSL_DONE_RESTART_LINE : WSL_DONE_LINE,
      status: null,
      detail: null,
      button: null,
    }
  }
  const busy = posting || setup.running
  const offer = setup.offer
  const title =
    offer === 'install'
      ? WSL_MISSING_LINE
      : offer === 'update'
        ? WSL_OLD_LINE
        : sentence(`Methods cannot run yet: ${facts.reason || 'the method runner did not start'}`)
  // Just declined: no button until the setup can start again (the facts are read again meanwhile).
  const pausing = setup.retry_in_secs !== undefined && !busy
  const button =
    offer === undefined || pausing ? null : { label: offer === 'install' ? 'Set up WSL' : 'Update WSL', busy }
  if (busy) {
    return { tone: 'info', title, status: WSL_RUNNING_LINE, detail: null, button }
  }
  if (last !== undefined) {
    const { status, detail, tone } = resultLine(last)
    return { tone, title, status: pausing ? `${status} ${WSL_AGAIN_SOON_LINE}` : status, detail, button }
  }
  return { tone: 'warning', title, status: button === null ? null : WSL_ASKS_LINE, detail: null, button }
}

const BAR: CSSProperties = {
  flex: 'none',
  padding: '8px 28px',
  borderBottom: '1px solid var(--txr-border)',
  background: 'var(--txr-surface-dim)',
}

const BODY: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }

/** wsl.exe's own lines, as it printed them (the log panel's face). */
const DETAIL: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-line',
  fontFamily: "'Source Code Pro', ui-monospace, monospace",
  fontSize: 12.5,
}

/**
 * WslSetupNotice — Windows only: the shell's notice when methods cannot run
 * because WSL 2 is missing or too old, with "Set up WSL" / "Update WSL" (the
 * registered `sandbox.setupWsl` action, so the palette and the AI agent start
 * the same setup). The setup starts at once and goes on after the person at
 * the PC confirms in the app's own dialog (Windows may also ask); the notice
 * shows it running, then its result. After a No the button comes back a
 * minute later. Other reasons are said without a button.
 *
 * It sits under the header, in the demo notice's slot, on every screen of
 * the app: a Windows user learns it on the start screen, before choosing
 * files and methods, and on Models, where "Use example" also runs methods.
 * Absent in the demo and while the mode read is pending (nothing is read
 * then), on other systems and when methods can run (the server then reports
 * no `wsl_setup`). The server checks the permissions: a refused read shows
 * nothing, a refused setup says why in a message. (The shell reads no
 * permission itself: it renders before and without a signed-in view.)
 */
export function WslSetupNotice() {
  const { isDesktop } = useAppMode()
  const { facts, posting } = useWslSetup(isDesktop)
  if (!isDesktop || facts === null) return null
  const view = wslNoticeView(facts, posting)

  const onSetUp = async (): Promise<void> => {
    try {
      await runAction('sandbox.setupWsl', {})
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'The WSL setup could not start')
    }
  }

  return (
    <section role="region" aria-label="WSL notice" data-testid="txr-wsl-notice" style={BAR}>
      <Alert tone={view.tone} title={view.title} data-testid="txr-wsl-notice-alert">
        {view.status !== null || view.detail !== null || view.button !== null ? (
          <div style={BODY}>
            {view.status !== null ? (
              <p data-testid="txr-wsl-notice-status" style={{ margin: 0 }}>
                {view.status}
              </p>
            ) : null}
            {view.detail !== null ? (
              <p data-testid="txr-wsl-notice-detail" style={DETAIL}>
                {view.detail}
              </p>
            ) : null}
            {view.button !== null ? (
              <Button
                data-testid="txr-wsl-notice-setup"
                variant="outline"
                loading={view.button.busy}
                onClick={() => void onSetUp()}
              >
                {view.button.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Alert>
    </section>
  )
}
