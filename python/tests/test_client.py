"""End-to-end: Python client against the real HTTP server with in-memory providers.

Run from the repo root: python3 -m unittest discover -s python/tests
"""

import os
import re
import signal
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "python"))

from sandboxrouter import Client, SandboxRouterError  # noqa: E402


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # One node process (no tsx wrapper child) in its own group, so teardown can't orphan it.
        cls.proc = subprocess.Popen(
            ["node", "--import", "tsx", "test/py-harness.ts"],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        line = cls.proc.stdout.readline()
        m = re.match(r"PORT=(\d+)", line)
        if not m:
            cls.proc.kill()
            raise RuntimeError(f"harness did not start: {line!r}")
        cls.sr = Client(f"http://127.0.0.1:{m.group(1)}", token="pytok")

    @classmethod
    def tearDownClass(cls):
        os.killpg(cls.proc.pid, signal.SIGKILL)
        cls.proc.wait()

    def test_auth_required(self):
        bad = Client(self.sr.base_url, token="nope")
        with self.assertRaises(SandboxRouterError) as e:
            bad.providers()
        self.assertEqual(e.exception.status, 401)

    def test_providers_and_route(self):
        self.assertIn("maritime", [p["id"] for p in self.sr.providers()])
        usable = [c["provider"] for c in self.sr.route(gpu="T4") if not c.get("skip")]
        self.assertEqual(usable, ["modal"])

    def test_sandbox_lifecycle_with_fallback(self):
        with self.sr.create(vcpu=1, memory_gb=1, env={"X": "1"}) as sbx:
            self.assertEqual(sbx.provider, "daytona")
            self.assertEqual([a["provider"] for a in sbx.attempts], ["maritime", "daytona"])
            self.assertEqual(sbx.exec("ls").stdout, "ran: ls\n")

            out, err = [], []
            r = sbx.exec("ls", on_stdout=out.append, on_stderr=err.append)
            self.assertEqual(out, ["ran: ", "ls\n"])
            self.assertEqual(err, ["warn\n"])
            self.assertEqual(r.exit_code, 0)

            sbx.write_file("/tmp/a.bin", b"\x00\x01\xff")
            self.assertEqual(sbx.read_file("/tmp/a.bin"), b"\x00\x01\xff")
            sbx.write_file("/tmp/t.txt", "héllo")
            self.assertEqual(sbx.read_text("/tmp/t.txt"), "héllo")
            sbx.pause()

    def test_routing_failure_carries_attempts(self):
        with self.assertRaises(SandboxRouterError) as e:
            self.sr.create(provider="maritime", fallback=False)
        self.assertEqual(e.exception.status, 503)
        self.assertEqual(e.exception.code, "all_failed")
        self.assertEqual(e.exception.attempts[0]["provider"], "maritime")

    def test_rejects_unknown_option(self):
        with self.assertRaises(TypeError):
            self.sr.create(cpus=2)

    def test_no_computer_provider(self):
        with self.assertRaises(SandboxRouterError) as e:
            self.sr.computer(os="linux")
        self.assertIn("no provider offers a linux computer", e.exception.message)


if __name__ == "__main__":
    unittest.main()
