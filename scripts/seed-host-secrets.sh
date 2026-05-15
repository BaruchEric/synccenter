#!/usr/bin/env bash
# seed-host-secrets.sh — collect Syncthing device IDs + API keys from the
# operator and write sops-encrypted secrets files to synccenter-config/secrets/.
#
# Run from any directory; the script auto-discovers synccenter-config as a
# sibling of the directory containing this script.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
CONFIG_REPO="${SC_CONFIG_DIR:-${REPO_ROOT}/../synccenter-config}"

if [[ ! -d "${CONFIG_REPO}/secrets" ]]; then
  echo "synccenter-config not found at ${CONFIG_REPO}" >&2
  echo "  pass via SC_CONFIG_DIR=<path> if it lives elsewhere" >&2
  exit 1
fi
command -v sops >/dev/null || { echo "sops not installed (brew install sops)"; exit 1; }
[[ -f "${CONFIG_REPO}/.sops.yaml" ]] || { echo "no .sops.yaml in ${CONFIG_REPO} — see phase-1-bringup Step 1"; exit 1; }

prompt() {
  local label="$1"
  local var
  read -r -p "  ${label}: " var
  printf "%s" "${var}"
}

declare -A IDS APIKEYS
HOSTS=(mac-studio qnap-ts453d win-desktop)

echo "==> collecting Syncthing identities for ${HOSTS[*]}"
echo "    (leave a host blank to skip it — useful if you only have two of three)"
for h in "${HOSTS[@]}"; do
  echo
  echo "  ${h}:"
  id=$(prompt "  device ID")
  key=$(prompt "  API key  ")
  [[ -n "${id}"  ]] && IDS[$h]="${id}"
  [[ -n "${key}" ]] && APIKEYS[$h]="${key}"
done

write_yaml() {
  local path="$1"
  shift
  local tmp; tmp=$(mktemp -t sc-secrets-XXXXXX.yaml)
  {
    while [[ $# -gt 0 ]]; do
      printf "%s: %s\n" "$1" "$2"
      shift 2
    done
  } > "${tmp}"
  sops --encrypt "${tmp}" > "${path}"
  rm -f "${tmp}"
  echo "  wrote ${path}"
}

KEYS_OUT="${CONFIG_REPO}/secrets/syncthing-api-keys.enc.yaml"
IDS_OUT="${CONFIG_REPO}/secrets/syncthing-device-ids.enc.yaml"

echo
echo "==> encrypting with sops"
write_yaml_args=()
for h in "${HOSTS[@]}"; do
  if [[ -n "${APIKEYS[$h]:-}" ]]; then
    write_yaml_args+=("${h}" "${APIKEYS[$h]}")
  fi
done
write_yaml "${KEYS_OUT}" "${write_yaml_args[@]}"

write_yaml_args=()
for h in "${HOSTS[@]}"; do
  if [[ -n "${IDS[$h]:-}" ]]; then
    write_yaml_args+=("${h}" "${IDS[$h]}")
  fi
done
write_yaml "${IDS_OUT}" "${write_yaml_args[@]}"

echo
echo "Done. Inspect with:"
echo "    sops -d ${KEYS_OUT}"
echo "    sops -d ${IDS_OUT}"
echo
echo "Then:"
echo "    cd ${CONFIG_REPO}"
echo "    git add secrets/ && git commit -m 'phase-1: seal syncthing identities'"
