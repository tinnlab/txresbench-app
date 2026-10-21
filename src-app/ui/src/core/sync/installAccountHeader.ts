// App-side stamping of the ACTIVE-ACCOUNT header (`X-Account-Id`) onto every
// SAME-ORIGIN request, without touching the SDK. The SDK api-client
// (`@ziee/framework/api-client`) builds request headers internally and exposes no
// app-registerable header hook, and the accounts epic deliberately makes NO SDK
// change — so the app installs a thin fetch + XMLHttpRequest interceptor at
// bootstrap that reads the `getAccountId()` holder and adds the header when set.
//
// It fires ONLY when an org has been switched to (the holder is non-null); for a
// solo user / on desktop the switcher never sets it, so this is a pure pass-through.
// Scoped to same-origin so it never leaks the header to a cross-origin asset/CDN.
// (If the SDK later grows a proper request-header seam, this can be retired — see
// SDK_GAPS.md.)

import { getAccountId } from './accountId'

/** Is `url` (absolute or relative) the app's OWN origin? */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin
  } catch {
    return false
  }
}

let installed = false

/** Install the fetch + XHR interceptors. Idempotent; a no-op outside the browser. */
export function installAccountHeaderStamping(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  // ── fetch ──
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const id = getAccountId()
    if (id) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      if (isSameOrigin(url)) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        )
        headers.set('X-Account-Id', id)
        init = { ...init, headers }
      }
    }
    return originalFetch(input as RequestInfo, init)
  }

  // ── XMLHttpRequest (the multipart upload path uses XHR for progress) ──
  const XHR = XMLHttpRequest.prototype
  const originalOpen = XHR.open
  const originalSend = XHR.send
  const URL_KEY = '__accountHeaderUrl'

  XHR.open = function (
    this: XMLHttpRequest & { [URL_KEY]?: string },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this[URL_KEY] = typeof url === 'string' ? url : url.href
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>)
  }

  XHR.send = function (this: XMLHttpRequest & { [URL_KEY]?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const id = getAccountId()
    const url = this[URL_KEY]
    if (id && url && isSameOrigin(url)) {
      try {
        this.setRequestHeader('X-Account-Id', id)
      } catch {
        // setRequestHeader can throw if the state is wrong; the request still proceeds.
      }
    }
    return originalSend.call(this, body ?? null)
  }
}
