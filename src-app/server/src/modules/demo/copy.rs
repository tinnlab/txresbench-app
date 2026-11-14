//! The demo's canonical copy — the notice text the config's key maps to
//! (demo-mode ITEM-1). ONE place for the server-emitted sentence so the
//! notice bar (ITEM-5) and the History/Models/Help statements (ITEM-7) can
//! quote the same server text; the full page copy stays with those items.
//!
//! No location claims (DEC-5 / qa-fixes2 rule): the sentences say "demo",
//! never where it runs.

/// The default text key (the plan's `demo.notice` value).
pub const DEFAULT_NOTICE_KEY: &str = "demo_banner";

/// The canonical one-line notice (the spec section 2 sentence).
pub const DEFAULT_NOTICE_TEXT: &str =
    "Runs and models here are shared with everyone who visits the demo.";

/// Map a config-supplied text KEY to the sentence. An unknown key falls back
/// to [`DEFAULT_NOTICE_TEXT`] with a log line — a deployment never ships a
/// blank banner over a key typo, and a future key gets its own entry here
/// (the server copy stays ONE table, like the route allowlist).
pub fn notice_text(key: &str) -> String {
    match key {
        DEFAULT_NOTICE_KEY => DEFAULT_NOTICE_TEXT.to_string(),
        other => {
            tracing::warn!(
                key = other,
                "unknown demo notice key; using the default notice text"
            );
            DEFAULT_NOTICE_TEXT.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_key_maps_to_the_canonical_sentence() {
        assert_eq!(notice_text(DEFAULT_NOTICE_KEY), DEFAULT_NOTICE_TEXT);
    }

    #[test]
    fn unknown_key_falls_back_to_the_default() {
        assert_eq!(notice_text("no-such-key"), DEFAULT_NOTICE_TEXT);
    }

    #[test]
    fn the_sentence_is_location_neutral() {
        // DEC-5: no location claims anywhere in the demo copy.
        for word in ["served", "hosted", "website", "url", "web app"] {
            assert!(
                !DEFAULT_NOTICE_TEXT.to_lowercase().contains(word),
                "the notice must not claim a location: {word}"
            );
        }
    }
}
