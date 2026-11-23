"""Serve Station Pilot and its assets on a fixed loopback origin."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 8765
URL = f"http://{HOST}:{PORT}/"
ASSETS = {"/", "/index.html", "/app.js", "/playout.js", "/storage.js", "/waveform.js", "/covers.js", "/library_links.js", "/limiter.js", "/pilot_dsp.wasm", "/style.css", "/icon.png"}


class AppHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        if self.headers.get("Host") != f"{HOST}:{PORT}":
            self.send_error(400)
            return None
        if urlsplit(self.path).path not in ASSETS:
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def make_server(port=PORT):
    app_path = Path(__file__).resolve().parent
    return ThreadingHTTPServer((HOST, port), partial(AppHandler, directory=app_path))

if __name__ == "__main__":
    with make_server() as server:
        print(f"Station Pilot is available at {URL}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
