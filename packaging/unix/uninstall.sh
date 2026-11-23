#!/bin/sh
set -eu
package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Station Pilot setup needs Python 3.9 or later.' >&2
    exit 1
fi
exec python3 -B "$package/manage.py" uninstall "$@"
