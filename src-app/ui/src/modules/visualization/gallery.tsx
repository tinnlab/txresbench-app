// gallery.tsx — the app component-gallery surface for the visualization module.
// The RICH interactive browsing surface is the dedicated Showcase (viz-showcase.html /
// `npm run viz-showcase`, DEC-36); this satisfies the shared @ziee/gallery
// completeness gate. The /visualization page auto-enumerates from the router store.
import type { ModuleGallery } from '@ziee/gallery'

export const gallery: ModuleGallery = { crawlOnly: true }
