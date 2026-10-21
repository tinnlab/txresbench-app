#!/usr/bin/env bash
# cloud-sim-kind.sh — RETIRED-SUBSTRATE (historical stub).
#
# The Level-2 kind / k3d Kubernetes substrate this script drove has been RETIRED.
# The cloud-sim compute k8s is now a REAL k3s node provisioned by floci / floci-gcp
# (Docker-backed rancher/k3s), NOT kind/k3d:
#
#   * floci      (AWS EKS→k3s): scripts/cloud-sim-floci.sh     (eks-up / contract-k8s)
#   * floci-gcp  (GCP GKE→k3s): scripts/cloud-sim-floci-gcp.sh (gke-up / contract-k8s)
#
# Image load into the floci k3s node is `docker save | ctr images import` (neither
# `kind load` nor `k3d image import` apply). See each floci script's contract-k8s.
#
# This stub exists only so a muscle-memory `just cloud-sim-kind-up` / direct call
# fails LOUDLY with a pointer, instead of silently doing nothing.
set -uo pipefail
echo "cloud-sim-kind.sh is RETIRED. Use the floci k3s compute substrate instead:" >&2
echo "  just cloud-sim-test-floci-k8s        # AWS EKS→k3s KubernetesBackend contract" >&2
echo "  just cloud-sim-test-floci-gcp-k8s    # GCP GKE→k3s KubernetesBackend contract" >&2
exit 2
