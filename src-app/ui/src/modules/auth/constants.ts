// Constants shared across the OAuth flow modules. Duplicating the
// sessionStorage key between ProviderButtons (writer) and
// AuthCallbackPage (reader) is an easy way to silently break the
// post-login redirect — both modules must use this single source.

export const SESSION_RETURN_TO_KEY = 'ziee.oauth.returnTo'
