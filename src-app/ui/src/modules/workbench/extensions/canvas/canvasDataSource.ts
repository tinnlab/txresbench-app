// canvasDataSource — the canvas extension's HANDLE on the project data plane.
//
// The plane itself (`buildProjectDataSource`, the memoized `(pull, streaming)` pair) moved to
// `extensions/data/projectSources.ts` under ITEM-42, because the `data` capability's columnar
// read is now a second consumer of the SAME source and a memo left here would have given it a
// second instance — two multicasts, two decodes, the "second byte path" DEC-20 was resolved to
// avoid (see that file's header for the whole argument).
//
// What stays here is the canvas's own vocabulary for it. The names are the ones ITEM-8's
// memoization test and the canvas call sites already use, so the move is a relocation and not a
// rename: `canvasDataSource.test.ts` pins the memo through exactly these symbols and is
// deliberately UNEDITED by that item — it is the merged behaviour the move could silently undo.

export {
  buildProjectDataSource as buildCanvasDataSource,
  buildProjectSources as buildCanvasSources,
  __resetProjectSourcesForTests as __resetCanvasSourcesForTests,
  type ProjectSources as CanvasSources,
} from '../data'
