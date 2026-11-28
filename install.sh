#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
    printf '%s\n' 'Run this script as your desktop user. It uses sudo for Linux system packages when needed.' >&2
    exit 1
fi

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ ! -f rust/Cargo.toml ] || [ ! -f pilot_dsp.wasm ]; then
    printf '%s\n' 'Station Pilot source files are missing. Use the complete checkout.' >&2
    exit 1
fi

os=$(uname -s)
case "$os" in
    Darwin)
        if ! xcrun --find clang >/dev/null 2>&1; then
            printf '%s\n' 'Install the Xcode Command Line Tools, then run sh install.sh again.' >&2
            xcode-select --install || true
            exit 1
        fi
        ;;
    Linux)
        if ! command -v apt-get >/dev/null 2>&1; then
            printf '%s\n' 'Automatic Linux dependency setup requires a Debian or Ubuntu-based distribution.' >&2
            exit 1
        fi
        ;;
    *)
        printf '%s\n' 'This source installer supports macOS and Debian or Ubuntu-based Linux.' >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *)
        printf '%s\n' 'Station Pilot setup supports x86-64 and ARM64.' >&2
        exit 1
        ;;
esac

if [ "$os" = Linux ]; then
    set --
    for package in build-essential ca-certificates curl pkg-config python3 xdg-utils \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
        gstreamer1.0-plugins-good gstreamer1.0-libav
    do
        if [ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null)" != installed ]; then
            set -- "$@" "$package"
        fi
    done
    if [ "$#" -gt 0 ]; then
        sudo apt-get update
        sudo apt-get install "$@"
    fi
fi

if ! command -v python3 >/dev/null 2>&1 ||
    ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
    printf '%s\n' 'Station Pilot setup needs Python 3.9 or later. Install it and run sh install.sh again.' >&2
    exit 1
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/station-pilot.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
if command -v rustup >/dev/null 2>&1; then
    rustup update stable
else
    curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs --output "$stage/rustup-init.sh"
    sh "$stage/rustup-init.sh" -y --profile minimal --default-toolchain stable --no-modify-path
fi

target="$(pwd)/rust/target"
rustup run stable cargo build --release --locked --manifest-path rust/Cargo.toml --target-dir "$target"
python3 packaging/build-unix.py "$stage/Station-Pilot.tar.gz" --native-host "$target/release/station-pilot"
tar -xzf "$stage/Station-Pilot.tar.gz" -C "$stage"
sh "$stage/Station-Pilot/install.sh"
