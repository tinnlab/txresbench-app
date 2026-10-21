#!/usr/bin/env bash
# cloud-sim.sh — RETIRED-SUBSTRATE (historical stub).
#
# The MinIO(S3) + fake-gcs-server(GCS) docker-compose substrate this script drove
# has been RETIRED. The cloud-sim is now standardized on floci + floci-gcp ONLY:
#
#   * floci      (AWS): S3 on :4566 + EKS→k3s  → scripts/cloud-sim-floci.sh
#   * floci-gcp  (GCP): GCS on :4588 + GKE→k3s → scripts/cloud-sim-floci-gcp.sh
#
# floci-gcp lifts the limitation that kept this substrate around: the native-GCS
# WRITE contract now runs against a local emulator (the RETIRED-SUBSTRATE
# fake-gcs-server served no writes object_store could use).
#
# This stub exists only so a muscle-memory `just cloud-sim-up` / direct call
# fails LOUDLY with a pointer, instead of silently doing nothing.
set -uo pipefail
echo "cloud-sim.sh is RETIRED. Use the floci substrate instead:" >&2
echo "  just cloud-sim-floci-up          # AWS: S3 + EKS→k3s   (scripts/cloud-sim-floci.sh)" >&2
echo "  just cloud-sim-floci-gcp-up      # GCP: GCS + GKE→k3s  (scripts/cloud-sim-floci-gcp.sh)" >&2
echo "  just cloud-sim-test-floci        # S3 ObjectStore contract on floci" >&2
echo "  just cloud-sim-test-floci-gcs    # native-GCS ObjectStore contract on floci-gcp" >&2
exit 2
