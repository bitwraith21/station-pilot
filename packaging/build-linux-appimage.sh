#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    printf '%s\n' 'Usage: sh packaging/build-linux-appimage.sh <compiled binary> <output AppImage>' >&2
    exit 2
fi
case "$(uname -s):$(uname -m)" in
    Linux:x86_64) ;;
    *) printf '%s\n' 'Build the compact Linux x64 AppImage on a Linux x86-64 host.' >&2; exit 1 ;;
esac

project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=$1
output=$2
if [ ! -x "$binary" ]; then
    printf '%s\n' "Missing Linux executable: $binary" >&2
    exit 1
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/station-pilot-appimage.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

image="$stage/StationPilot.AppDir"
mkdir -p "$image/usr/bin"
install -m 755 "$binary" "$image/usr/bin/station-pilot"
install -m 644 "$project/icon.png" "$image/station-pilot.png"
ln -s station-pilot.png "$image/.DirIcon"
cat > "$image/station-pilot.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Station Pilot
Comment=Radio playout workstation
Exec=station-pilot
Icon=station-pilot
Categories=AudioVideo;Audio;
Terminal=false
EOF

cat > "$image/AppRun" <<'EOF'
#!/bin/sh
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ldd "$base/usr/bin/station-pilot" | grep -q 'not found'; then
    message='Station Pilot Compact needs the system WebKitGTK 4.1 and GTK libraries. On Zorin or Ubuntu, install libwebkit2gtk-4.1-0 and try again.'
    printf '%s\n' "$message" >&2
    if command -v zenity >/dev/null 2>&1; then zenity --error --title='Station Pilot' --text="$message"; fi
    exit 1
fi
exec "$base/usr/bin/station-pilot" "$@"
EOF
chmod +x "$image/AppRun"

tool="$stage/appimagetool"
curl --proto '=https' -fsSL --retry 3 \
    https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage -o "$tool"
printf '%s  %s\n' ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0 "$tool" | sha256sum -c -
chmod +x "$tool"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$tool" "$image" "$output"
