#!/usr/bin/env python3
"""A stand-in for ZenMux's API, for testing the plugin without a real key.

Serves, on http://127.0.0.1:3599:
  GET  /api/v1/models
  GET  /api/v1/management/subscription/detail
  GET  /api/v1/management/generation
  POST /api/v1/chat/completions   (stream or whole)
Any Authorization header is accepted.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = json.load(open(os.path.join(HERE, "zenmux-models-probe.json"), encoding="utf-8"))
PLANS = json.load(open(os.path.join(HERE, "probe-get_all_plans.json"), encoding="utf-8"))

SUBSCRIPTION = {
    "success": True,
    "data": {
        "plan": {"tier": "ultra", "amount_usd": 200, "interval": "month", "expires_at": "2026-12-14T05:02:42.000Z"},
        "currency": "usd",
        "base_usd_per_flow": 0.03283,
        "effective_usd_per_flow": 0.03283,
        "account_status": "healthy",
        "quota_5_hour": {
            "usage_percentage": 0.1039,
            "resets_at": "2026-11-14T10:05:17.000Z",
            "remaining_resets": 3,
            "max_flows": 50,
            "used_flows": 5.19,
            "remaining_flows": 44.81,
            "used_value_usd": 0.17,
            "max_value_usd": 1.6415,
        },
        "quota_7_day": {
            "usage_percentage": 0.0244,
            "resets_at": "2026-11-21T05:05:17.000Z",
            "max_flows": 213,
            "used_flows": 5.19,
            "remaining_flows": 207.81,
            "used_value_usd": 0.17,
            "max_value_usd": 6.9927,
        },
        "quota_monthly": {"max_flows": 914, "max_value_usd": 30.0},
    },
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("mock: " + (fmt % args) + "\n")

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, events):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        for ev in events:
            self.wfile.write(("data: " + json.dumps(ev) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/v1/models":
            return self._json(200, MODELS)
        if u.path == "/api/subscription/public/get_all_plans":
            return self._json(200, PLANS)
        if u.path == "/api/v1/management/subscription/detail":
            return self._json(200, SUBSCRIPTION)
        if u.path == "/api/v1/management/generation":
            # Real ZenMux answers 403 to a subscription key on management
            # endpoints; the plugin must fall back to a chat probe.
            return self._json(403, {"success": False, "message": "Invalid API key", "data": None})
        return self._json(404, {"success": False, "message": "no such route: " + u.path})

    def _key(self):
        h = self.headers.get("authorization") or ""
        return h[7:].strip() if h.lower().startswith("bearer ") else ""

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        if u.path != "/api/v1/chat/completions":
            return self._json(404, {"error": {"message": "no such route: " + u.path}})
        # A stand-in for ZenMux's key check: sk-subs-… / sk-payg-… work.
        if not self._key().startswith(("sk-subs-", "sk-payg-")):
            return self._json(
                403,
                {"error": {"code": "403", "type": "access_denied",
                           "message": "You have no permission to access this resource (api_key_source: subscription)"}},
            )
        model = body.get("model") or "deepseek/deepseek-v4.1-flash"
        if body.get("stream"):
            return self._sse(
                [
                    {
                        "id": "chatcmpl-mock",
                        "object": "chat.completion.chunk",
                        "created": 1794636000,
                        "model": model,
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}],
                    },
                    {
                        "id": "chatcmpl-mock",
                        "object": "chat.completion.chunk",
                        "created": 1794636000,
                        "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    },
                ]
            )
        return self._json(
            200,
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 1794636000,
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3599
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()