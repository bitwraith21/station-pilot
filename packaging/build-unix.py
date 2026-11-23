"""Build the Station Pilot macOS and Linux release archive."""
from pathlib import Path
import argparse
import platform
import sys
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--native-host", "--linux-host", dest="native_host", type=Path, required=True)
args = parser.parse_args()
package = Path(__file__).resolve().parent
root = package.parent
system = {"darwin": "macos", "linux": "linux"}.get(sys.platform)
machine = platform.machine().lower()
arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
if not system or not arch or not args.native_host.is_file():
    parser.error("Build on the target OS and architecture and pass the compiled Station Pilot binary.")
assets = ("icon.png", "README.md")
scripts = ("desktop.py", "manage.py", "install.sh", "uninstall.sh", "Install Station Pilot.command", "StationPilot.icns")


def add_file(archive, path, name=None, executable=False):
    info = archive.gettarinfo(str(path), f"Station-Pilot/{name or path.name}")
    info.mode = 0o755 if executable or path.suffix in (".command", ".sh") else 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    with path.open("rb") as payload:
        archive.addfile(info, payload)


with tarfile.open(args.output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    for name in assets:
        add_file(archive, root / name)
    for name in scripts:
        add_file(archive, package / "unix" / name)
    add_file(archive, args.native_host, f"station-pilot-{system}-{arch}", executable=True)
