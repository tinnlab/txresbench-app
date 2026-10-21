// annotate-geojson.story.tsx (ITEM-15, P1) — the lossless, QuPath-portable GeoJSON round-trip
// (ITEM-7). Drives the REAL `importGeoJson` → `exportGeoJson` → re-import against the
// `QUPATH_GEOJSON_SAMPLE` (polygon-with-hole, multipolygon, classified point, foreign
// `measurements`/`objectType`), shown as a DATA view: the imported annotations, the exported
// FeatureCollection, and a round-trip verdict (vertex count + class + foreign props preserved,
// INV-7). Presentational — no deck / GL. Authored at desktop + 390px.

import { useMemo, type CSSProperties } from 'react'
import { importGeoJson, exportGeoJson } from '../../viz-core/annotate/geojson'
import { QUPATH_GEOJSON_SAMPLE } from '../../viz-core/annotate/annotateFixture'
import type { Annotation } from '../../viz-core/annotate/annotateModel'
import { WidthKnob } from './annotateStoryKit'
import { registerStory } from '../registry'

/** Total vertex count of an annotation's geometry (a coarse round-trip invariant). */
function vertexCount(a: Annotation): number {
  const g = a.geometry
  if (g.kind === 'point') return 1
  if (g.kind === 'path') return g.xy.length / 2
  return g.rings.reduce((n, r) => n + r.length / 2, 0)
}

function AnnotateGeojsonStory() {
  const result = useMemo(() => {
    const parsed = JSON.parse(QUPATH_GEOJSON_SAMPLE)
    const imported = importGeoJson(parsed)
    const exported = exportGeoJson(imported.annotations, imported.classes)
    const reimported = importGeoJson(exported)

    // Round-trip invariants: same annotation count, per-annotation vertex counts + class + foreign
    // props preserved (compared by stable id).
    const byId = new Map(reimported.annotations.map(a => [a.id, a]))
    let ok = imported.annotations.length === reimported.annotations.length
    for (const a of imported.annotations) {
      const b = byId.get(a.id)
      if (
        !b ||
        vertexCount(a) !== vertexCount(b) ||
        a.classId !== b.classId ||
        JSON.stringify(a.properties ?? {}) !== JSON.stringify(b.properties ?? {})
      ) {
        ok = false
        break
      }
    }
    return { imported, exported, ok }
  }, [])

  const cell: CSSProperties = { padding: '2px 8px', borderBottom: '1px solid rgba(128,128,128,0.15)' }

  return (
    <div
      data-testid="viz-annotate-geojson"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <strong>QuPath GeoJSON round-trip</strong>
        <span
          data-testid="annotate-geojson-verdict"
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            fontWeight: 700,
            background: result.ok ? 'rgb(60,160,90)' : 'rgb(200,60,60)',
            color: 'white',
          }}
        >
          {result.ok ? 'ROUND-TRIP OK' : 'ROUND-TRIP FAILED'}
        </span>
        <span style={{ opacity: 0.7 }}>{result.imported.annotations.length} annotations imported</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WidthKnob testId="annotate-geojson">
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', gap: 8, padding: 8, overflow: 'auto', flexWrap: 'wrap' }}>
            {/* imported annotations */}
            <div style={{ flex: '1 1 320px', minWidth: 260, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 4, fontSize: 12 }}>
              <div style={{ ...cell, fontWeight: 600, background: 'rgba(128,128,128,0.1)' }}>Imported annotations</div>
              {result.imported.annotations.map(a => (
                <div key={a.id} data-testid={`annotate-geojson-row-${a.id}`} style={cell}>
                  <code>{a.id}</code> · {a.geometry.kind} · {vertexCount(a)} vtx ·{' '}
                  <b>{a.classId ?? '—'}</b>
                  {a.properties && Object.keys(a.properties).length > 0 && (
                    <span style={{ opacity: 0.6 }}> · foreign: {Object.keys(a.properties).join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
            {/* exported FeatureCollection */}
            <div style={{ flex: '1 1 320px', minWidth: 260, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 4, fontSize: 11 }}>
              <div style={{ ...cell, fontWeight: 600, background: 'rgba(128,128,128,0.1)' }}>
                Exported FeatureCollection ({result.exported.features.length} features)
              </div>
              <pre
                data-testid="annotate-geojson-export"
                style={{ margin: 0, padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '100%' }}
              >
                {JSON.stringify(result.exported, null, 2)}
              </pre>
            </div>
          </div>
        </WidthKnob>
      </div>
    </div>
  )
}

registerStory({
  id: 'annotate-geojson',
  category: 'Export',
  title: 'Annotate — GeoJSON import → export → re-import (lossless, QuPath-portable)',
  covers: 'annotate-geojson',
  Component: AnnotateGeojsonStory,
})
