"""Python client for the sandboxrouter HTTP API (`npx @sandboxrouter/sdk serve`).

Standard library only.

    from sandboxrouter import Client

    sr = Client("http://127.0.0.1:8787", token="...")
    with sr.create(vcpu=2, memory_gb=4, strategy="cheapest") as sbx:
        print(sbx.provider, sbx.exec("python3 -c 'print(6*7)'").stdout)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional

__all__ = ["Client", "Sandbox", "Computer", "ExecResult", "SandboxRouterError"]
__version__ = "0.1.0"


class SandboxRouterError(Exception):
    def __init__(self, status: int, message: str, attempts: Optional[list] = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message
        self.attempts = attempts or []


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int = 0

    @classmethod
    def _from(cls, d: dict) -> "ExecResult":
        return cls(d.get("exitCode", -1), d.get("stdout", ""), d.get("stderr", ""), d.get("durationMs", 0))


_SPEC_KEYS = {
    "vcpu": "vcpu",
    "memory_gb": "memoryGb",
    "gpu": "gpu",
    "env": "env",
    "timeout_minutes": "timeoutMinutes",
    "image": "image",
    "metadata": "metadata",
    "provider": "provider",
    "strategy": "strategy",
    "fallback": "fallback",
    "create_timeout_seconds": "createTimeoutSeconds",
    "require": "require",
}


class Client:
    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, timeout: float = 660):
        self.base_url = (base_url or os.environ.get("SANDBOXROUTER_URL") or "http://127.0.0.1:8787").rstrip("/")
        self.token = token if token is not None else os.environ.get("SANDBOXROUTER_TOKEN")
        self.timeout = timeout

    # -- transport -------------------------------------------------------------------------

    def _open(self, method: str, path: str, *, json_body: Any = None, data: Optional[bytes] = None, accept: Optional[str] = None):
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if json_body is not None:
            data = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        elif data is not None:
            headers["Content-Type"] = "application/octet-stream"
        if accept:
            headers["Accept"] = accept
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                body = json.loads(raw)
            except ValueError:
                body = {"error": raw}
            raise SandboxRouterError(e.code, body.get("error", raw), body.get("attempts")) from None

    def _json(self, method: str, path: str, body: Any = None) -> Any:
        with self._open(method, path, json_body=body) as r:
            raw = r.read()
        return json.loads(raw) if raw else {}

    def _bytes(self, method: str, path: str, data: Optional[bytes] = None) -> bytes:
        with self._open(method, path, data=data) as r:
            return r.read()

    # -- API -------------------------------------------------------------------------------

    def providers(self) -> list:
        return self._json("GET", "/v1/providers")["providers"]

    def route(self, **spec: Any) -> list:
        return self._json("POST", "/v1/route", _camel(spec))["candidates"]

    def create(self, **spec: Any) -> "Sandbox":
        """Start a sandbox. Spec: vcpu, memory_gb, gpu, env, timeout_minutes, image, metadata.
        Routing: provider (str or list), strategy ("default" | "verified" | "cheapest" | "fastest"; default: tested providers first), fallback
        (True, False or "any"), create_timeout_seconds, require."""
        d = self._json("POST", "/v1/sandboxes", _camel(spec))
        return Sandbox(self, d["id"], d["provider"], d.get("estimatedHourlyUsd"), d.get("attempts", []))

    def sandbox(self, sandbox_id: str) -> "Sandbox":
        """Handle for an existing sandbox id ("provider:nativeId")."""
        return Sandbox(self, sandbox_id, sandbox_id.split(":", 1)[0])

    def computer(self, os: str = "linux", external_user_id: Optional[str] = None, **extra: Any) -> "Computer":
        body = {"os": os, **extra}
        if external_user_id is not None:
            body["externalUserId"] = external_user_id
        d = self._json("POST", "/v1/computers", body)
        return Computer(self, d["id"], d)


def _camel(spec: dict) -> dict:
    out = {}
    for k, v in spec.items():
        if v is None:
            continue
        if k not in _SPEC_KEYS:
            raise TypeError(f"unknown option: {k}")
        out[_SPEC_KEYS[k]] = v
    return out


def _sse(resp) -> Iterator[tuple]:
    event, data = "message", []
    for raw in resp:
        line = raw.decode().rstrip("\r\n")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[6:] if line[5:6] == " " else line[5:])
    if data:
        yield event, "\n".join(data)


@dataclass
class Sandbox:
    client: Client
    id: str
    provider: str
    estimated_hourly_usd: Optional[float] = None
    attempts: list = field(default_factory=list)

    def _p(self, suffix: str = "") -> str:
        return f"/v1/sandboxes/{urllib.parse.quote(self.id, safe='')}{suffix}"

    def exec(
        self,
        cmd: str,
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        timeout_seconds: Optional[int] = None,
        on_stdout: Optional[Callable[[str], None]] = None,
        on_stderr: Optional[Callable[[str], None]] = None,
    ) -> ExecResult:
        body = {k: v for k, v in {"cmd": cmd, "cwd": cwd, "env": env, "timeoutSeconds": timeout_seconds}.items() if v is not None}
        if not (on_stdout or on_stderr):
            return ExecResult._from(self.client._json("POST", self._p("/exec"), body))
        body["stream"] = True
        with self.client._open("POST", self._p("/exec"), json_body=body, accept="text/event-stream") as r:
            for event, data in _sse(r):
                payload = json.loads(data)
                if event == "stdout" and on_stdout:
                    on_stdout(payload)
                elif event == "stderr" and on_stderr:
                    on_stderr(payload)
                elif event == "result":
                    return ExecResult._from(payload)
                elif event == "error":
                    raise SandboxRouterError(502, payload.get("error", data))
        raise SandboxRouterError(502, "stream ended before the command finished")

    def write_file(self, path: str, content) -> None:
        data = content.encode() if isinstance(content, str) else bytes(content)
        self.client._bytes("PUT", self._p(f"/files?path={urllib.parse.quote(path)}"), data)

    def read_file(self, path: str) -> bytes:
        return self.client._bytes("GET", self._p(f"/files?path={urllib.parse.quote(path)}"))

    def read_text(self, path: str) -> str:
        return self.read_file(path).decode()

    def pause(self) -> None:
        self.client._json("POST", self._p("/pause"))

    def kill(self) -> None:
        self.client._json("DELETE", self._p())

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        self.kill()


class Computer:
    """A desktop or phone driven with computer-use actions (see ComputerAction in the TS docs)."""

    def __init__(self, client: Client, id: str, info: Optional[dict] = None):
        self.client = client
        self.id = id
        self.info = info or {}

    def _p(self, suffix: str = "") -> str:
        return f"/v1/computers/{urllib.parse.quote(self.id, safe='')}{suffix}"

    def act(self, action: str, **fields: Any) -> dict:
        return self.client._json("POST", self._p("/actions"), {"action": action, **fields})

    def act_batch(self, actions: list) -> list:
        return self.client._json("POST", self._p("/actions"), {"actions": actions})["results"]

    def screenshot(self, format: str = "png") -> bytes:
        return self.client._bytes("GET", self._p(f"/screenshot?format={format}"))

    def exec(self, command: str, timeout_seconds: Optional[int] = None) -> dict:
        return self.client._json("POST", self._p("/exec"), {"command": command, "timeoutSeconds": timeout_seconds})

    def write_file(self, path: str, content) -> None:
        data = content.encode() if isinstance(content, str) else bytes(content)
        self.client._bytes("PUT", self._p(f"/files?path={urllib.parse.quote(path)}"), data)

    def read_file(self, path: str) -> bytes:
        return self.client._bytes("GET", self._p(f"/files?path={urllib.parse.quote(path)}"))

    def viewer(self, mode: str = "watch", ttl_seconds: Optional[int] = None, reason: Optional[str] = None) -> dict:
        body = {k: v for k, v in {"mode": mode, "ttlSeconds": ttl_seconds, "reason": reason}.items() if v is not None}
        return self.client._json("POST", self._p("/viewer"), body)

    def sleep(self) -> None:
        self.client._json("POST", self._p("/sleep"))

    def delete(self) -> None:
        self.client._json("DELETE", self._p())
