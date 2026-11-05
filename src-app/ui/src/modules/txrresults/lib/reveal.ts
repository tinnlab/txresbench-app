/**
 * txrresults folder-reveal seam (ITEM-10, PROV-UR-7 / DEC-9) — the H board's
 * "Open the folder" made real: the run's output directory (the engine's
 * `TxrRunDetail.dir`, passed through as DATA — never constructed here) is
 * opened in the system file manager via the desktop shell's
 * `reveal_in_file_manager` command (`src-app/desktop/tauri/src/commands.rs`,
 * implemented with the already-dependency-present `tauri-plugin-opener`).
 *
 * The seam is desktop-gated by the pure `isDesktop()` predicate
 * (`@/core/platform`, INV-6): web mode NEVER invokes and the components
 * render the path text with no button (TEST-UR-16's positive control —
 * the path present, the button absent, a desktop gate not a never-rendered
 * line). A rejection is swallowed to the path-only rendering: the open
 * failing (directory gone, platform file manager unavailable) must not
 * take the board down or flash a status message — the line itself was
 * already the information.
 *
 * The barrel re-exports `revealRunDir` (PROV-UR-9, GAP-HIST-4):
 * `ui-history`'s screen-K "Open the folder" imports through this module's
 * barrel, never a seam-mirror of its own.
 */
import { isDesktop } from '@/core/platform'

/** The Tauri global's shape this seam touches (`getBaseURL.ts`'s `invoke` idiom). */
interface TauriGlobal {
  core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/**
 * Open `dir` in the system file manager when this is the desktop shell;
 * resolve (no-op) in web mode or when the Tauri bridge is absent. The
 * command name and the `{path}` argument are the desktop crate's contract
 * (TEST-UR-9 pins both); the reveal only ever happens after
 * `isDesktop()` — the pure predicate, never duplicated logic.
 */
export function revealRunDir(dir: string): Promise<void> {
  if (!isDesktop()) return Promise.resolve()
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  const invoke = tauri?.core?.invoke
  if (!invoke) return Promise.resolve()
  return invoke('reveal_in_file_manager', { path: dir }).then(
    () => undefined,
    () => undefined,
  )
}
