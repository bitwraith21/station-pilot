"""Shared per-user paths and exclusive lock for the native desktop installer."""
from contextlib import contextmanager
from pathlib import Path
import fcntl
import os
import sys


MARKER = ".station-pilot-install"


def locations():
    app = Path(__file__).resolve().parent
    installed = app.name == "app" and (app / MARKER).is_file()
    if sys.platform == "darwin":
        root = app.parent if installed else Path.home() / "Library" / "Application Support" / "Station Pilot"
        return root, Path.home() / "Applications"
    if sys.platform.startswith("linux"):
        if installed:
            return app.parent, app.parent.parent / "applications"
        data_home = Path(os.environ.get("XDG_DATA_HOME", ""))
        if not data_home.is_absolute():
            data_home = Path.home() / ".local" / "share"
        return data_home / "station-pilot", data_home / "applications"
    raise RuntimeError("This setup supports macOS and Linux.")


def check_directory(path):
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise RuntimeError(f"Expected a regular directory at {path}")


@contextmanager
def workstation_lock(root):
    check_directory(root)
    data = root / "data"
    check_directory(data)
    data.mkdir(parents=True, exist_ok=True)
    lock_path = data / ".workstation.lock"
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Close Station Pilot before running setup or opening another session.") from error
        yield data
