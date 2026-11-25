"""Install or remove the per-user Station Pilot workstation."""
from argparse import ArgumentParser
from pathlib import Path
import os
import platform
import plistlib
import shlex
import shutil
import sys

from desktop import MARKER, check_directory, locations, workstation_lock


UNINSTALL_MARKER = "# Station Pilot managed shortcut"
FILES = ("icon.png", "StationPilot.icns", "desktop.py", "manage.py", "README.md")


def write_file(path, text, executable=False):
    path.unlink(missing_ok=True)
    path.write_text(text, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def ensure_owned(path, marker_path):
    check_directory(path)
    if path.exists() and not marker_path.is_file():
        raise RuntimeError(f"Cannot replace the existing folder at {path}")


def validate_shortcuts(shortcuts):
    if sys.platform == "darwin":
        bundle = shortcuts / "Station Pilot.app"
        ensure_owned(bundle, bundle / MARKER)
        command = shortcuts / "Uninstall Station Pilot.command"
        if command.is_symlink() or (command.exists() and UNINSTALL_MARKER not in command.read_text(encoding="utf-8")):
            raise RuntimeError(f"Cannot replace the existing shortcut at {command}")
    else:
        for filename in ("station-pilot.desktop", "station-pilot-uninstall.desktop"):
            path = shortcuts / filename
            if path.is_symlink() or (path.exists() and UNINSTALL_MARKER not in path.read_text(encoding="utf-8")):
                raise RuntimeError(f"Cannot replace the existing shortcut at {path}")


def desktop_quote(text):
    # Desktop Entry fields unescape backslashes before the Exec parser runs.
    text = text.replace("%", "%%").replace("\\", "\\\\\\\\")
    for character in ('"', "`", "$"):
        text = text.replace(character, "\\\\" + character)
    return '"' + text + '"'


def make_shortcuts(app, shortcuts):
    shortcuts.mkdir(parents=True, exist_ok=True)
    python = sys.executable
    native = app / "station-pilot-native"
    launch = [str(native)]
    uninstall = [python, str(app / "manage.py"), "uninstall"]
    if sys.platform == "darwin":
        bundle = shortcuts / "Station Pilot.app"
        executable = bundle / "Contents" / "MacOS" / "StationPilot"
        executable.parent.mkdir(parents=True, exist_ok=True)
        resources = bundle / "Contents" / "Resources"
        resources.mkdir(exist_ok=True)
        shutil.copyfile(app / "StationPilot.icns", resources / "StationPilot.icns")
        write_file(bundle / MARKER, "Station Pilot\n")
        with (bundle / "Contents" / "Info.plist").open("wb") as handle:
            plistlib.dump({
                "CFBundleIdentifier": "org.stationpilot.workstation",
                "CFBundleName": "Station Pilot",
                "CFBundleDisplayName": "Station Pilot",
                "CFBundleExecutable": "StationPilot",
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": "0.4.4",
                "CFBundleShortVersionString": "0.4.4",
                "CFBundleIconFile": "StationPilot.icns",
                "LSUIElement": False,
            }, handle)
        executable.unlink(missing_ok=True)
        try:
            os.link(native, executable)
        except OSError:
            shutil.copy2(native, executable)
        write_file(shortcuts / "Uninstall Station Pilot.command",
                   "#!/bin/sh\n" + UNINSTALL_MARKER + "\nexec " + shlex.join(uninstall) + "\n", executable=True)
    else:
        for filename, name, argv, terminal in (
            ("station-pilot.desktop", "Station Pilot", launch, "false"),
            ("station-pilot-uninstall.desktop", "Uninstall Station Pilot", uninstall, "true"),
        ):
            command = " ".join(desktop_quote(arg) for arg in argv)
            write_file(shortcuts / filename, (
                "[Desktop Entry]\n" + UNINSTALL_MARKER + "\nType=Application\n"
                f"Name={name}\nExec={command}\nIcon={app / 'icon.png'}\n"
                f"Terminal={terminal}\nCategories=AudioVideo;Audio;\n"
            ))


def install(source):
    root, shortcuts = locations()
    app = root / "app"
    system = "macos" if sys.platform == "darwin" else "linux"
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)
    binary = source / f"station-pilot-{system}-{arch}"
    if not binary.is_file():
        raise RuntimeError(f"Use the Station Pilot package for {system} {arch}.")
    for name in FILES:
        if not (source / name).is_file():
            raise RuntimeError(f"Setup files are incomplete. Missing {name}.")
    validate_shortcuts(shortcuts)
    ensure_owned(app, app / MARKER)
    data = root / "data"
    ensure_owned(data, data / MARKER)
    with workstation_lock(root):
        write_file(data / MARKER, "Station Pilot data\n")
        app.mkdir(exist_ok=True)
        write_file(app / MARKER, "Station Pilot\n")
        for name in FILES:
            target = app / name
            if target.exists() and source.joinpath(name).samefile(target):
                continue
            incoming = app / (name + ".tmp")
            incoming.unlink(missing_ok=True)
            shutil.copyfile(source / name, incoming)
            incoming.replace(target)
        native = app / "station-pilot-native"
        incoming = app / "station-pilot-native.tmp"
        incoming.unlink(missing_ok=True)
        shutil.copyfile(binary, incoming)
        incoming.chmod(0o755)
        incoming.replace(native)
        make_shortcuts(app, shortcuts)
    print(f"Station Pilot installed. Open it from {'Applications' if sys.platform == 'darwin' else 'your app menu'}.")
    print(f"Application data: {root}")


def uninstall(remove_data):
    root, shortcuts = locations()
    app = root / "app"
    data = root / "data"
    ensure_owned(app, app / MARKER)
    ensure_owned(data, data / MARKER)
    validate_shortcuts(shortcuts)
    if not app.exists() and not data.exists():
        print("Station Pilot is already uninstalled.")
        return
    if remove_data is None:
        if not sys.stdin.isatty():
            raise RuntimeError("Specify --keep-data or --remove-data for a non-interactive uninstall.")
        print("Uninstall Station Pilot. Saved data includes imported audio, queue, schedules, settings, and history.")
        choices = {"": False, "k": False, "keep": False, "r": True, "remove": True}
        while True:
            answer = input("[K]eep data, [R]emove data, or [C]ancel? [K] ").strip().lower()
            if answer in ("c", "cancel"):
                return
            if answer in choices:
                remove_data = choices[answer]
                break

    with workstation_lock(root):
        if app.is_dir():
            shutil.rmtree(app)
        if sys.platform == "darwin":
            bundle = shortcuts / "Station Pilot.app"
            if bundle.is_dir():
                shutil.rmtree(bundle)
            (shortcuts / "Uninstall Station Pilot.command").unlink(missing_ok=True)
        else:
            (shortcuts / "station-pilot.desktop").unlink(missing_ok=True)
            (shortcuts / "station-pilot-uninstall.desktop").unlink(missing_ok=True)
        if remove_data:
            if sys.platform == "darwin":
                for base in ("WebKit", "Caches"):
                    profile = Path.home() / "Library" / base / "org.stationpilot.workstation"
                    check_directory(profile)
                    if profile.is_dir():
                        shutil.rmtree(profile)
            shutil.rmtree(data)
        elif not (data / MARKER).exists():
            write_file(data / MARKER, "Station Pilot data\n")
    if remove_data and root.is_dir() and not any(root.iterdir()):
        root.rmdir()
    print("Station Pilot uninstalled. " + ("Saved data was removed." if remove_data else f"Saved data retained in {data}."))


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent)
    choices = parser.add_mutually_exclusive_group()
    choices.add_argument("--keep-data", dest="remove_data", action="store_false")
    choices.add_argument("--remove-data", dest="remove_data", action="store_true")
    parser.set_defaults(remove_data=None)
    args = parser.parse_args()
    try:
        if args.action == "install":
            install(args.source)
        else:
            uninstall(args.remove_data)
    except (EOFError, KeyboardInterrupt):
        print("\nSetup cancelled.")
        sys.exit(1)
    except (OSError, RuntimeError) as error:
        print(f"Station Pilot setup: {error}", file=sys.stderr)
        sys.exit(1)
