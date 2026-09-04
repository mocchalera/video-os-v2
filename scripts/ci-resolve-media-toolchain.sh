#!/usr/bin/env bash
# Pin ffmpeg/ffprobe for public CI. Do not trust PATH or apt mirrors.
#
# First candidate investigated: @remotion/compositor-linux-x64-gnu@4.0.452
# from package-lock.json (integrity pinned). That package does ship ffmpeg
# and ffprobe, and Remotion launches them from the package directory
# (Linux uses cwd; Darwin needs DYLD_LIBRARY_PATH). The Remotion build is
# filter-reduced: no testsrc2, color, ebur128, or volumedetect. node-runtime
# tests generate fixtures with those filters, so the compositor binaries
# cannot be the PATH toolchain. This script still fail-closes if the
# lockfile/install pin drifts.
#
# PATH toolchain: digest-pinned, versioned Linux x86_64 static build.

set -euo pipefail

PINNED_COMPOSITOR_NAME='@remotion/compositor-linux-x64-gnu'
PINNED_COMPOSITOR_VERSION='4.0.452'
PINNED_COMPOSITOR_INTEGRITY='sha512-W/obco3o/vqdqtbXlAm3m6m9ZjA9LGGeJkEjT3+6ar2jkOSLi2S6qIhz9Y/ewi5cN2hKaFV1rlEwVGNqfEia+w=='
PINNED_COMPOSITOR_PATH='node_modules/@remotion/compositor-linux-x64-gnu'

PINNED_FFMPEG_VERSION='6.0.1'
PINNED_FFMPEG_URL='https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz'
PINNED_FFMPEG_SHA256='28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5'
BROKER_SEARCH_PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
BROKER_INSTALL_DIR='/usr/local/bin'

fail_closed() {
  echo "fail-closed: $*" >&2
  exit 1
}

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  fail_closed "pinned media toolchain is defined only for linux x86_64 CI runners"
fi

if [ ! -f package-lock.json ]; then
  fail_closed "package-lock.json is missing"
fi

node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const pkg = lock.packages?.["node_modules/@remotion/compositor-linux-x64-gnu"];
const expectedVersion = "4.0.452";
const expectedIntegrity =
  "sha512-W/obco3o/vqdqtbXlAm3m6m9ZjA9LGGeJkEjT3+6ar2jkOSLi2S6qIhz9Y/ewi5cN2hKaFV1rlEwVGNqfEia+w==";

if (!pkg) {
  throw new Error("package-lock.json is missing @remotion/compositor-linux-x64-gnu");
}
if (pkg.version !== expectedVersion) {
  throw new Error(`Unexpected compositor version: ${pkg.version}`);
}
if (pkg.integrity !== expectedIntegrity) {
  throw new Error(`Unexpected compositor integrity: ${pkg.integrity}`);
}
NODE

if [ ! -f "${PINNED_COMPOSITOR_PATH}/package.json" ]; then
  fail_closed "npm ci did not materialize ${PINNED_COMPOSITOR_NAME}"
fi

installed_version="$(node -p "require('./${PINNED_COMPOSITOR_PATH}/package.json').version")"
if [ "${installed_version}" != "${PINNED_COMPOSITOR_VERSION}" ]; then
  fail_closed "installed compositor version ${installed_version} != ${PINNED_COMPOSITOR_VERSION}"
fi

if [ ! -e "${PINNED_COMPOSITOR_PATH}/ffmpeg" ] || [ ! -e "${PINNED_COMPOSITOR_PATH}/ffprobe" ]; then
  fail_closed "compositor package path is missing bundled ffmpeg/ffprobe"
fi

echo "Verified ${PINNED_COMPOSITOR_NAME}@${PINNED_COMPOSITOR_VERSION} (${PINNED_COMPOSITOR_INTEGRITY})"
echo "Not using compositor ffmpeg/ffprobe on PATH: Remotion n7.1 build lacks testsrc2/color/ebur128/volumedetect."

workdir="${RUNNER_TEMP:-/tmp}/videoos-pinned-ffmpeg"
rm -rf "${workdir}"
mkdir -p "${workdir}/src" "${workdir}/bin"
tarball="${workdir}/src/ffmpeg.tar.xz"

echo "Downloading pinned ffmpeg ${PINNED_FFMPEG_VERSION}"
if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 180 \
  -o "${tarball}" "${PINNED_FFMPEG_URL}"; then
  fail_closed "could not download pinned ffmpeg tarball"
fi

actual_sha256="$(sha256sum "${tarball}" | awk '{print $1}')"
if [ "${actual_sha256}" != "${PINNED_FFMPEG_SHA256}" ]; then
  fail_closed "ffmpeg tarball sha256 ${actual_sha256} != ${PINNED_FFMPEG_SHA256}"
fi

tar -xJf "${tarball}" -C "${workdir}/src"
ffmpeg_src="$(find "${workdir}/src" -type f -name ffmpeg | sort | head -n 1 || true)"
ffprobe_src="$(find "${workdir}/src" -type f -name ffprobe | sort | head -n 1 || true)"
if [ -z "${ffmpeg_src}" ] || [ -z "${ffprobe_src}" ]; then
  fail_closed "pinned tarball did not contain ffmpeg and ffprobe"
fi

cp "${ffmpeg_src}" "${workdir}/bin/ffmpeg"
cp "${ffprobe_src}" "${workdir}/bin/ffprobe"
chmod 0755 "${workdir}/bin/ffmpeg" "${workdir}/bin/ffprobe"

if [ ! -x "${workdir}/bin/ffmpeg" ] || [ ! -x "${workdir}/bin/ffprobe" ]; then
  fail_closed "pinned ffmpeg/ffprobe are not executable"
fi

install_verified_binary() {
  local src="$1"
  local dest="$2"
  local src_sha dest_sha nlink banner discovered expected_banner
  src_sha="$(sha256sum "${src}" | awk '{print $1}')"
  if [ -z "${src_sha}" ]; then
    fail_closed "could not hash verified ${src}"
  fi

  if ! sudo mkdir -p "${BROKER_INSTALL_DIR}"; then
    fail_closed "could not create ${BROKER_INSTALL_DIR}"
  fi
  # Unlink first so a pre-existing symlink or file is never adopted or followed.
  if ! sudo rm -f "${dest}"; then
    fail_closed "could not unlink ${dest} before verified install"
  fi
  if ! sudo cp "${src}" "${dest}"; then
    fail_closed "could not install verified bytes to ${dest}"
  fi
  if ! sudo chmod 0755 "${dest}"; then
    fail_closed "could not mark ${dest} executable"
  fi

  if [ -L "${dest}" ]; then
    fail_closed "installed ${dest} is a symlink"
  fi
  if [ ! -f "${dest}" ] || [ ! -x "${dest}" ]; then
    fail_closed "installed ${dest} is not an executable regular file"
  fi
  nlink="$(stat -c '%h' "${dest}")"
  if [ "${nlink}" != "1" ]; then
    fail_closed "installed ${dest} nlink=${nlink} is not 1"
  fi
  dest_sha="$(sha256sum "${dest}" | awk '{print $1}')"
  if [ "${dest_sha}" != "${src_sha}" ]; then
    fail_closed "installed ${dest} digest ${dest_sha} != verified tarball bytes ${src_sha}"
  fi
  banner="$("${dest}" -version | sed -n '1p')"
  expected_banner="$(basename "${dest}") version ${PINNED_FFMPEG_VERSION}-static "
  case "${banner}" in
    "${expected_banner}"*) ;;
    *) fail_closed "unexpected installed banner for ${dest}: ${banner}" ;;
  esac
  discovered="$(PATH="${BROKER_SEARCH_PATH}" /usr/bin/which "$(basename "${dest}")" || true)"
  if [ "${discovered}" != "${dest}" ]; then
    fail_closed "broker which path discovered '${discovered}' instead of ${dest}"
  fi
}

install_verified_binary "${workdir}/bin/ffmpeg" "${BROKER_INSTALL_DIR}/ffmpeg"
install_verified_binary "${workdir}/bin/ffprobe" "${BROKER_INSTALL_DIR}/ffprobe"

ffmpeg_banner="$("${BROKER_INSTALL_DIR}/ffmpeg" -version | sed -n '1p')"
ffprobe_banner="$("${BROKER_INSTALL_DIR}/ffprobe" -version | sed -n '1p')"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "${BROKER_INSTALL_DIR}" >> "${GITHUB_PATH}"
  echo "${workdir}/bin" >> "${GITHUB_PATH}"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "VIDEOOS_PINNED_FFMPEG=${BROKER_INSTALL_DIR}/ffmpeg" >> "${GITHUB_ENV}"
  echo "VIDEOOS_PINNED_FFPROBE=${BROKER_INSTALL_DIR}/ffprobe" >> "${GITHUB_ENV}"
fi

echo "Pinned media toolchain ready: ${PINNED_FFMPEG_VERSION}"
echo "ffmpeg=${BROKER_INSTALL_DIR}/ffmpeg"
echo "ffprobe=${BROKER_INSTALL_DIR}/ffprobe"
echo "${ffmpeg_banner}"
echo "${ffprobe_banner}"
echo "tarball_sha256=${PINNED_FFMPEG_SHA256}"
echo "ffmpeg_sha256=$(sha256sum "${BROKER_INSTALL_DIR}/ffmpeg" | awk '{print $1}')"
echo "ffprobe_sha256=$(sha256sum "${BROKER_INSTALL_DIR}/ffprobe" | awk '{print $1}')"
