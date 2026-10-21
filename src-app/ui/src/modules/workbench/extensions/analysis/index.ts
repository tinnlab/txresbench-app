// `extensions/analysis` — the launch / run / re-run / preview surfaces for a
// contributed ANALYSIS. It registers through `contributions` exactly as a third-party
// package would (the `core/shell/builtinViews.ts` pattern: a descriptor carrying an
// `extensionId`, resolved through the shared registry), so nothing here is privileged.
//
// It is a CONSUMER of the `data` + `jobs` capabilities, resolved out of the broker by
// id — it holds no plane of its own.

export { AnalysisRunPanel, buildInputs, pickNewest, upsertPhase, errMessage } from './AnalysisRunPanel.tsx'
export type { RunState } from './AnalysisRunPanel.tsx'
export { AnalysisFlowGuidance, type AnalysisFlowGuidanceProps } from './AnalysisFlowGuidance.tsx'
export { AnalysisVisualizations } from './AnalysisVisualizations.tsx'
export { ParamOutcomePreview, type ParamOutcomePreviewProps } from './ParamOutcomePreview.tsx'
export { RerunPane } from './RerunPane.tsx'
export { RunProgressConsole, type RunPhase, type ConsoleStatus } from './RunProgressConsole.tsx'
export * from './chaining.ts'
export * from './discovery.ts'
export * from './inputEconomy.ts'
export * from './launcherAvailability.ts'
export * from './nextSteps.ts'
export * from './paramPreview.ts'
export * from './rerun.ts'
export * from './runHistory.ts'
