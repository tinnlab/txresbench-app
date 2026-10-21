// @ziee/dock — the pure, content-agnostic cross-window DOCKING mechanics extracted from @ziee/viz
// (see DOCK_LAYER_EXTRACTION.md + cross-window-docking/PATTERN.md). It owns the split-tree layout,
// the multi-container model + moves, the popup-window registry, the cross-window <ContainerWindows>
// portal host (content injected via `renderContainer`), and the drag geometry/lifecycle. It knows
// NOTHING about pane CONTENT — panes are opaque ids; a consumer (viz, workbench, …) supplies its own
// content model + renderer. No deck/viz imports; react/react-dom are peers.
//
// ONE ui dependency, deliberately: `ContainerWindows` installs @ziee/kit's `PortalContainerProvider`
// around the subtree it portals into a popup window, so every kit overlay rendered by a popped-out
// pane targets THAT window's document instead of the opener's. Placing it here — at the boundary
// that creates the second document — is what makes the fix un-forgettable: no pane, no renderer and
// no overlay call site has to opt in. It is a context provider only (no DOM, no styles).

export * from './layout/splitTree'
export * from './containers'
export * from './popupWindowRegistry'
export * from './ContainerWindows'
export * from './dragGeometry'
export * from './useGripDrag'
