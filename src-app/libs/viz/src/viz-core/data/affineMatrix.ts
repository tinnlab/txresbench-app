// affineMatrix.ts — turn the 2×3 spatial AFFINE into a deck.gl 4×4 `modelMatrix`
// so the cell↔image alignment runs on the GPU (DEC-26), NOT as an O(2N)-per-point
// CPU pass. Passing this matrix to a ScatterplotLayer lets deck multiply it into
// every vertex in the shader, so the RAW positions go straight to the GPU buffer
// (zero-copy) and `data/image.ts::transformPositions` is retired from the hot path
// (it stays only as the CPU parity oracle for tests).

import type { Affine } from './image'

/**
 * Build a 16-element **column-major** 4×4 modelMatrix from a 2×3 row-major affine
 * `[a, b, tx, c, d, ty]` (x' = a·x + b·y + tx ; y' = c·x + d·y + ty).
 *
 * math.gl / gl-matrix (what deck.gl feeds its shaders) consume a Matrix4 as a flat
 * COLUMN-MAJOR array. The 3D matrix that reproduces the 2D affine — leaving z
 * untouched, homogeneous w = 1 — is, in ROW-major form:
 * ```
 *   [ a  b  0  tx ]
 *   [ c  d  0  ty ]
 *   [ 0  0  1  0  ]
 *   [ 0  0  0  1  ]
 * ```
 * whose COLUMN-major flattening (column 0, column 1, column 2, column 3) is
 * `[a, c, 0, 0,  b, d, 0, 0,  0, 0, 1, 0,  tx, ty, 0, 1]`.
 */
export function affineToModelMatrix(a: Affine): number[] {
  return [
    a[0], a[3], 0, 0, // column 0
    a[1], a[4], 0, 0, // column 1
    0, 0, 1, 0, // column 2
    a[2], a[5], 0, 1, // column 3
  ]
}
