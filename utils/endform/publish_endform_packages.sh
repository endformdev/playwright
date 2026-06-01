#!/usr/bin/env bash
set -euo pipefail

function usage {
  echo "usage: $(basename "$0") [--beta|--release] [--dry-run] [--out-dir <path>] [--skip-smoke]"
  echo
  echo "Stages and publishes @endform Playwright packages."
  echo
  echo "--beta       publish a pre-release version under the beta dist-tag"
  echo "--release    publish a stable version under the latest dist-tag"
  echo "--dry-run    stage and validate tarballs without publishing"
}

MODE=""
DRY_RUN=0
OUT_DIR=""
SKIP_SMOKE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --beta|--release)
      MODE="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --out-dir=*)
      OUT_DIR="${1#--out-dir=}"
      shift
      ;;
    --skip-smoke)
      SKIP_SMOKE=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${MODE}" ]]; then
  echo "Please specify --beta or --release" >&2
  usage >&2
  exit 1
fi

if ! command -v npm >/dev/null; then
  echo "ERROR: npm is not found" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
cd "${ROOT_DIR}"

VERSION="$(node -e 'console.log(require("./package.json").version)')"
NPM_TAG=""

if [[ "${MODE}" == "--release" ]]; then
  if [[ "${VERSION}" == *-* ]]; then
    echo "ERROR: cannot publish pre-release version ${VERSION} with --release" >&2
    exit 1
  fi
  NPM_TAG="latest"
else
  if [[ "${VERSION}" != *-beta* ]]; then
    echo "ERROR: --beta requires a beta version, got ${VERSION}" >&2
    exit 1
  fi
  NPM_TAG="beta"
fi

STAGE_ARGS=()
if [[ -n "${OUT_DIR}" ]]; then
  STAGE_ARGS+=("--out-dir" "${OUT_DIR}")
else
  OUT_DIR="${ROOT_DIR}/endform-packages"
fi
if [[ "${SKIP_SMOKE}" == "1" ]]; then
  STAGE_ARGS+=("--skip-smoke")
fi

if [[ ${#STAGE_ARGS[@]} -eq 0 ]]; then
  node "${SCRIPT_DIR}/stage_endform_packages.js"
else
  node "${SCRIPT_DIR}/stage_endform_packages.js" "${STAGE_ARGS[@]}"
fi

CORE_TGZ="${OUT_DIR}/endform-playwright-core-${VERSION}.tgz"
PLAYWRIGHT_TGZ="${OUT_DIR}/endform-playwright-${VERSION}.tgz"
TEST_TGZ="${OUT_DIR}/endform-playwright-test-${VERSION}.tgz"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "Dry run complete. Tarballs are ready in ${OUT_DIR}:"
  echo "  ${CORE_TGZ}"
  echo "  ${PLAYWRIGHT_TGZ}"
  echo "  ${TEST_TGZ}"
  exit 0
fi

npm publish --access=public --tag="${NPM_TAG}" "${CORE_TGZ}"
npm publish --access=public --tag="${NPM_TAG}" "${PLAYWRIGHT_TGZ}"
npm publish --access=public --tag="${NPM_TAG}" "${TEST_TGZ}"

echo "Published @endform Playwright ${VERSION} with dist-tag ${NPM_TAG}."
