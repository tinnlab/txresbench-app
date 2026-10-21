// crypto.randomUUID exists ONLY in a secure context (https, or http on localhost/127.0.0.1). A
// plain-HTTP dev/preview instance reached over a LAN IP (host 0.0.0.0) is NOT a secure context, so
// `crypto.randomUUID` is undefined there and the actions engine / router / workbench crash
// (resolveSessionId → TypeError). Provide a standards-compliant RFC-4122 v4 fallback built from
// `crypto.getRandomValues` (which IS available in insecure contexts). No-op when the native one
// exists. Imported first in `main.tsx` so it runs before any module calls it.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  const uuidv4 = (): `${string}-${string}-${string}-${string}-${string}` => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant 10
    const h = Array.from(b, x => x.toString(16).padStart(2, '0'))
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
  }
  ;(crypto as Crypto & { randomUUID: () => ReturnType<typeof uuidv4> }).randomUUID = uuidv4
}
