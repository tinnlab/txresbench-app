//! SQLite-leg query transport types (the `sqlite-backend` variant only).
//!
//! sqlx's sqlite driver has a much flatter type system than Postgres: there
//! is no array type and no jsonb type — `text[]` and `jsonb` both live as
//! TEXT (JSON array text / JSON text, per the DEC-8 type map). The query
//! macros therefore cannot infer `Vec<String>` / `serde_json::Value` / …
//! from a TEXT column, so the sqlite-leg SELECTs override those columns with
//! [`JsonValue<T>`] (TEXT-compatible decode/encode); the query macro's
//! generated row mapping then calls `.into()` on the decoded value to fill
//! the model field, which the concrete `From` impls below provide.
//!
//! A `From<JsonValue<T>> for T` BLANKET is not possible: the self type would
//! be an uncovered type parameter, which the coherence rules reject
//! (`E0210` — a foreign trait cannot be implemented for a bare type
//! parameter). The two monomorphizations the crate actually uses are spelled
//! out explicitly; add a third impl here if a future leg needs one.
//!
//! The binds in the sqlite-leg INSERT/UPDATE use `sqlx::types::Json` (the
//! driver's own JSON wrapper) for non-null JSON values; `Option` JSON binds
//! are pre-serialized to `Option<String>` so `None` stays SQL NULL (a bound
//! `Json(None)` would store the TEXT `null`, not NULL — a different row
//! value on both engines).

use serde::{Deserialize, Serialize};
use sqlx::{Decode, Encode, Sqlite, Type};

/// TEXT-column transport for a jsonb/text[]-mapped Rust value.
///
/// Serializes/deserializes the inner `T` as JSON text; the query-macro
/// generated decode's `.into()` converts it to the model field via the
/// concrete `From` impls at the bottom of this module.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonValue<T>(pub T);

impl<T> Type<Sqlite> for JsonValue<T> {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <str as Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &sqlx::sqlite::SqliteTypeInfo) -> bool {
        <str as Type<Sqlite>>::compatible(ty)
    }
}

impl<'r, T> Decode<'r, Sqlite> for JsonValue<T>
where
    T: serde::de::DeserializeOwned,
{
    fn decode(value: sqlx::sqlite::SqliteValueRef<'r>) -> Result<Self, sqlx::error::BoxDynError> {
        let text = <&str as Decode<'r, Sqlite>>::decode(value)?;
        let inner = serde_json::from_str(text)?;
        Ok(JsonValue(inner))
    }
}

impl<'q, T> Encode<'q, Sqlite> for JsonValue<T>
where
    T: Serialize,
{
    fn encode_by_ref(
        &self,
        args: &mut Vec<sqlx::sqlite::SqliteArgumentValue<'q>>,
    ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        args.push(sqlx::sqlite::SqliteArgumentValue::Text(
            serde_json::to_string(&self.0)?.into(),
        ));
        Ok(sqlx::encode::IsNull::No)
    }
}

/// `text[]` columns (`users.permissions`, `groups.permissions`).
impl From<JsonValue<Vec<String>>> for Vec<String> {
    fn from(v: JsonValue<Vec<String>>) -> Self {
        v.0
    }
}

/// `jsonb` columns (`auth_providers.config`, `user_auth_links.external_data`,
/// `pending_account_links.external_data`).
impl From<JsonValue<serde_json::Value>> for serde_json::Value {
    fn from(v: JsonValue<serde_json::Value>) -> Self {
        v.0
    }
}
