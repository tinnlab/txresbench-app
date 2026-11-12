//! `CytoServerBoot` — TxResBench's impl of the SDK harness's `ServerBoot` seam.
//!
//! This is the whole point of the dogfood: the reusable Tauri shell drives the
//! embedded server entirely through this seam. We hand it the server's
//! `boot_in_background` handle; the harness owns the window + single-user login.

use std::sync::Mutex;

use async_trait::async_trait;
use txresbench_core::ServerConfig;
use txresbench_desktop_harness::boot::{BootHandle, ServerBoot};

/// Holds the desktop config until the single `boot` call consumes it.
pub struct CytoServerBoot {
    config: Mutex<Option<ServerConfig>>,
}

impl CytoServerBoot {
    pub fn new(config: ServerConfig) -> Self {
        Self {
            config: Mutex::new(Some(config)),
        }
    }
}

#[async_trait]
impl ServerBoot for CytoServerBoot {
    async fn boot(&self) -> anyhow::Result<BootHandle> {
        // take() before the first await so the guard is dropped and the future
        // stays Send (mirrors app#1's TxResBenchServerBoot).
        let config = self
            .config
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow::anyhow!("CytoServerBoot::boot called more than once"))?;

        let parts = txresbench::boot_in_background(config)
            .await
            .map_err(|e| anyhow::anyhow!("failed to start embedded server: {e}"))?;

        Ok(BootHandle {
            addr: parts.addr,
            pool: (*parts.pool).clone(),
            jwt: parts.jwt,
        })
    }

    async fn shutdown(&self) {
        txresbench::cleanup().await;
    }
}
