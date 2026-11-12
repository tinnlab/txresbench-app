//! SQLite-leg query transport types (the `sqlite-backend` variant only).
//!
//! sqlx's sqlite driver has a much flatter type system than Postgres: there is
//! no array type and no jsonb type — `jsonb` lives as TEXT here (per the DEC-8
//! type map). The query macros therefore cannot infer `serde_json::Value` from
//! a TEXT column, so the sqlite-leg SELECTs override the `payload` column with
//! [`JsonValue<T>`] (TEXT-compatible decode/encode); the query macro's
//! generated row mapping then calls `.into()` on the decoded value to fill the
//! model field, which the concrete `From` impl at the bottom provides.
//!
//! The binds in the sqlite-leg INSERT use `sqlx::types::Json` — the driver's
//! own JSON wrapper — which encodes the same JSON text the column stores
//! (a `payload` JSON value is never NULL: the column default is `'{}'` and the
//! builder's own default is an empty object).

use serde::{Deserialize, Serialize};
use sqlx::{Decode, Encode, Sqlite};

/// TEXT-column transport for a jsonb-mapped Rust value.
///
/// Serializes/deserializes the inner `T` as JSON text; the query-macro
/// generated decode's `.into()` converts it to the model field via the
/// concrete `From` impls at the bottom of this module.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonValue<T>(pub T);

impl<T> sqlx::Type<Sqlite> for JsonValue<T> {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <str as sqlx::Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &sqlx::sqlite::SqliteTypeInfo) -> bool {
        <str as sqlx::Type<Sqlite>>::compatible(ty)
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

/// The `payload` jsonb column (`notifications.payload`).
impl From<JsonValue<serde_json::Value>> for serde_json::Value {
    fn from(v: JsonValue<serde_json::Value>) -> Self {
        v.0
    }
}
