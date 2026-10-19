"""Real synthetic process trees; no Codex or reverse-engineering engine runs."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import psutil

from benchmark import CleanupIncomplete, measure, OwnershipSession


SLEEPER = "import time; time.sleep(30)"
TREE = f"""
import json, subprocess, sys, time
children = [subprocess.Popen([sys.executable, '-c', {SLEEPER!r}], start_new_session=detached)
            for detached in (False, True)]
print(json.dumps([p.pid for p in children]), flush=True)
time.sleep(.2)
memory = bytearray(128 * 1024**2) if sys.argv[1] == 'memory' else None
if sys.argv[1] != 'exit': time.sleep(30)
"""


class BenchmarkCleanupTest(unittest.TestCase):
    def test_failures_before_target_launch_reap_prepared_helper(self):
        for stage in ("file-open", "prompt-write", "spawn"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(prefix="rea-benchmark-prepare-") as root:
                cause = OSError("injected " + stage)
                original_open, original_popen = Path.open, subprocess.Popen
                original_close = OwnershipSession.close
                owners = []

                def fail_open(path, *args, **kwargs):
                    if stage == "file-open" and path.name == "stdout.log":
                        raise cause
                    if stage == "prompt-write" and path.name == "stdin.txt":
                        stream = MagicMock()
                        stream.__enter__.return_value.write.side_effect = cause
                        return stream
                    return original_open(path, *args, **kwargs)

                def fail_spawn(command, *args, **kwargs):
                    if stage == "spawn" and command[0] == sys.executable:
                        raise cause
                    return original_popen(command, *args, **kwargs)

                def record_close(owner):
                    owners.append(owner)
                    return original_close(owner)

                with patch.object(Path, "open", fail_open), patch("benchmark.subprocess.Popen", fail_spawn), patch.object(OwnershipSession, "close", record_close):
                    with self.assertRaises(OSError) as raised:
                        measure([sys.executable, "-c", SLEEPER], Path(root) / "trial", prompt="input")
                self.assertIs(raised.exception, cause)
                self.assertEqual(len(owners), 1)
                self.assertIsNone(owners[0].child)
                self.assertTrue(owners[0].closed)
                self.assertEqual(owners[0].helper.returncode, 0)

    def test_attachment_timeout_retains_child_and_discards_only_its_late_receipt(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-attach-") as root:
            cause = TimeoutError("injected attachment response timeout")
            original_response = OwnershipSession._response
            owners = []

            def interrupt_attachment(owner, wanted, timeout=60):
                if wanted == 1:
                    owners.append(owner)
                    self.assertEqual(owner.ownership["leaderPid"], owner.child.pid)
                    raise cause
                return original_response(owner, wanted, timeout)

            with patch.object(OwnershipSession, "_response", interrupt_attachment):
                with self.assertRaises(TimeoutError) as raised:
                    measure([sys.executable, "-c", SLEEPER], Path(root) / "trial")
            self.assertIs(raised.exception, cause)
            self.assertEqual(owners[0].sequence, 3)  # observe, cleanup, close
            self.assertTrue(owners[0].cleaned)
            self.assertTrue(owners[0].closed)
            self.assertIsNotNone(owners[0].child.returncode)
            self.assertEqual(owners[0].helper.returncode, 0)

    def test_acknowledged_shutdown_retries_only_reaping(self):
        owner = OwnershipSession("node")
        try:
            with patch.object(owner.helper, "wait", side_effect=subprocess.TimeoutExpired("ownership helper", 5)), patch.object(owner, "_request", wraps=owner._request) as request:
                with self.assertRaises(subprocess.TimeoutExpired):
                    owner.close()
                self.assertTrue(owner.shutdown_acknowledged)
                self.assertTrue(owner.helper.stdin.closed)
                self.assertFalse(owner.closed)
                request.assert_called_once_with("close")
            with patch.object(owner, "_request", side_effect=AssertionError("shutdown must not send another request")):
                owner.close()
            self.assertTrue(owner.closed)
            self.assertEqual(owner.helper.returncode, 0)
        finally:
            owner.close()

    def test_unacknowledged_shutdown_consumes_late_receipt_without_resending(self):
        owner = OwnershipSession("node")
        try:
            with patch.object(owner, "_response", side_effect=TimeoutError("delayed close receipt")):
                with self.assertRaises(TimeoutError):
                    owner.close()
            owner.helper.stdin.close()  # Permit exit after the real helper sends its late receipt.
            owner.helper.wait(timeout=5)
            self.assertFalse(owner.shutdown_acknowledged)
            with patch.object(owner.helper.stdin, "write", side_effect=AssertionError("close must not be replayed")):
                owner.close()
            self.assertTrue(owner.shutdown_acknowledged)
            self.assertTrue(owner.closed)
            self.assertEqual(owner.sequence, 1)
        finally:
            if not owner.closed:
                owner.helper.stdin.close()
                owner.helper.wait(timeout=5)
                owner._release_streams()

    def test_explicit_close_refusal_releases_only_the_pending_request(self):
        owner = OwnershipSession("node")
        try:
            owner.shutdown_request = owner.sequence = 1
            owner.pending = b'{"id":1,"error":"injected close refusal"}\n'
            with self.assertRaisesRegex(RuntimeError, "injected close refusal"):
                owner.close()
            self.assertIsNone(owner.shutdown_request)
            self.assertFalse(owner.closed)
            owner.close()
            self.assertTrue(owner.closed)
            self.assertEqual(owner.sequence, 2)
        finally:
            owner.close()

    def test_failed_preparation_preserves_diagnostic_and_retries_unbound_reaping(self):
        for interrupt_wait in (False, True):
            with self.subTest(interrupt_wait=interrupt_wait):
                original_popen = subprocess.Popen
                helpers = []

                def prepare_failure(*args, **kwargs):
                    helper = original_popen(*args, **kwargs)
                    helpers.append(helper)
                    if interrupt_wait:
                        wait = helper.wait
                        attempts = 0

                        def interrupt_once(*args, **kwargs):
                            nonlocal attempts
                            attempts += 1
                            if attempts == 1:
                                raise subprocess.TimeoutExpired("preparing helper", 5)
                            return wait(*args, **kwargs)
                        helper.wait = interrupt_once
                    return helper

                with patch("benchmark.subprocess.Popen", prepare_failure):
                    with self.assertRaises(CleanupIncomplete if interrupt_wait else RuntimeError) as raised:
                        OwnershipSession(sys.executable)  # Python rejects the actual JS helper before preparation.
                failure = raised.exception
                if interrupt_wait:
                    self.assertIsNone(failure.owner.child)
                    failure.owner.close()
                    self.assertTrue(failure.owner.closed)
                    failure = failure.__cause__
                self.assertIn("SyntaxError", str(failure))
                self.assertIsNotNone(helpers[0].returncode)
                self.assertTrue(helpers[0].stdout.closed)

    def test_lost_helper_preserves_known_ownership_without_recreating_ledger(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-lost-") as root:
            original_observe = OwnershipSession.observe
            owners = []

            def lose_helper(owner):
                result = original_observe(owner)
                owners.append(owner)
                owner.helper.terminate()
                owner.helper.wait(timeout=5)
                return result

            try:
                with patch.object(OwnershipSession, "observe", lose_helper):
                    with self.assertRaises(CleanupIncomplete) as raised:
                        for name in ("first", "second"):
                            measure([sys.executable, "-c", SLEEPER], Path(root) / name, timeout=.2)
                self.assertFalse((Path(root) / "second").exists())
                self.assertEqual(len(owners), 1)
                owner = owners[0]
                self.assertIs(raised.exception.owner, owner)
                self.assertIs(raised.exception.ownership, owner.ownership)
                self.assertIs(raised.exception.child, owner.child)
                self.assertIsNone(owner.child.poll())
                self.assertFalse(owner.cleaned)
                with self.assertRaises((BrokenPipeError, RuntimeError)):
                    owner.cleanup()
                self.assertEqual(len(owners), 1)
            finally:
                # The fixture has exactly one child, whose live Popen handle is
                # retained even after intentional loss of the evidence helper.
                for owner in owners:
                    owner.child.terminate()
                    owner.child.wait(timeout=5)
                    owner._release_streams()
                    self.assertTrue(owner.closed)

    def test_limits_and_leader_exit_clean_children_including_detached_groups(self):
        for mode in ("timeout", "memory", "exit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="rea-benchmark-test-") as root:
                directory = Path(root) / "trial"
                result = measure([sys.executable, "-c", TREE, mode], directory,
                                 timeout=1 if mode == "timeout" else 10,
                                 memory_limit=64 * 1024**2 if mode == "memory" else 6 * 1024**3)
                self.assertEqual(result["interrupted_by_limit"], mode != "exit")
                self.assertTrue(result["cleanup"]["cleaned"])
                for pid in json.loads((directory / "stdout.log").read_text()):
                    self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)

    def test_unverified_cleanup_retains_manifest_and_stops_subsequent_trials(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-denied-") as root:
            first = Path(root) / "first"
            second = Path(root) / "second"

            snapshots = []

            def deny_cleanup(owner):
                owner.observe()
                snapshots.append(owner.coverage["snapshotCount"])
                return {"cleaned": False, "reason": "injected identity inspection denial"}

            try:
                with patch.object(OwnershipSession, "cleanup", deny_cleanup):
                    with self.assertRaises(CleanupIncomplete) as raised:
                        for directory in (first, second):
                            measure([sys.executable, "-c", SLEEPER], directory, timeout=.2)
                self.assertFalse(second.exists())
                self.assertFalse(json.loads((first / "resources.json").read_text())["cleanup"]["cleaned"])
                owner = raised.exception.owner
                helper_pid = owner.helper.pid
                self.assertIsNone(owner.helper.poll())
                owner.observe()
                self.assertGreater(owner.coverage["snapshotCount"], snapshots[0])
                self.assertEqual(owner.helper.pid, helper_pid)
                self.assertGreater(owner.coverage["retainedOwned"], 0)
            finally:
                self.assertEqual(raised.exception.ownership, json.loads((first / "ownership.json").read_text()))
                self.assertTrue(raised.exception.owner.cleanup()["cleaned"])
                raised.exception.child.wait(timeout=5)
                raised.exception.owner.close()
                self.assertEqual(raised.exception.owner.helper.returncode, 0)

    def test_failed_manifest_writes_preserve_cleanup_and_retry_without_files(self):
        for partial in (False, True):
            for denied in (False, True):
                with self.subTest(partial=partial, denied=denied), tempfile.TemporaryDirectory(prefix="rea-benchmark-write-") as root:
                    first, second = Path(root) / "first", Path(root) / "second"
                    write_text = Path.write_text
                    owner = None
                    original_cleanup = OwnershipSession.cleanup
                    cleanup_results = []
                    children = []
                    raised = None

                    def failed_write(path, data, *args, **kwargs):
                        if path.name == "ownership.json":
                            # Wait for acknowledged children before injecting the disk failure.
                            deadline = time.monotonic() + 5
                            while not children:
                                output = (first / "stdout.log").read_text()
                                if output.endswith("\n"):
                                    children.extend(json.loads(output))
                                elif time.monotonic() >= deadline:
                                    raise AssertionError("Synthetic process tree did not start")
                                else:
                                    time.sleep(.01)
                            if partial:
                                write_text(path, "{\"runId\":")
                            raise OSError("injected manifest write failure")
                        if path.name == "resources.json" and denied:
                            raise OSError("injected diagnostics write failure")
                        return write_text(path, data, *args, **kwargs)

                    def inspect_cleanup(session):
                        nonlocal owner
                        owner = session
                        result = ({"cleaned": False, "reason": "injected inspection denial"}
                                  if denied else original_cleanup(session))
                        cleanup_results.append(result)
                        return result

                    try:
                        with patch.object(Path, "write_text", failed_write), patch.object(OwnershipSession, "cleanup", inspect_cleanup):
                            with self.assertRaises(CleanupIncomplete if denied else OSError) as raised:
                                for directory in (first, second):
                                    measure([sys.executable, "-c", TREE, "timeout"], directory)
                        self.assertFalse(second.exists())
                        self.assertEqual(cleanup_results[0]["cleaned"], not denied)
                        if denied:
                            self.assertIs(raised.exception.owner, owner)
                            self.assertIs(raised.exception.ownership, owner.ownership)
                            self.assertRegex(str(raised.exception.__cause__), "manifest write failure")
                            self.assertIsNone(raised.exception.child.poll())
                        else:
                            self.assertRegex(str(raised.exception), "manifest write failure")
                            self.assertTrue(owner.closed)
                            self.assertEqual(owner.helper.returncode, 0)
                            for pid in [owner.ownership["leaderPid"], *children]:
                                self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)
                        if partial:
                            with self.assertRaises(json.JSONDecodeError):
                                json.loads((first / "ownership.json").read_text())
                        else:
                            self.assertFalse((first / "ownership.json").exists())
                    finally:
                        # No manifest is needed for retry, even after both writes failed.
                        if owner is not None and not owner.closed:
                            self.assertTrue(owner.cleanup()["cleaned"])
                        if denied and isinstance(getattr(raised, "exception", None), CleanupIncomplete):
                            raised.exception.child.wait(timeout=5)
                        if owner is not None:
                            owner.close()

    def test_large_prompt_does_not_block_limit_monitoring(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-stdin-") as root:
            result = measure([sys.executable, "-c", SLEEPER], Path(root) / "trial",
                             prompt="x" * 2 * 1024**2, timeout=.2)
            self.assertTrue(result["interrupted_by_limit"])
            self.assertTrue(result["cleanup"]["cleaned"])


if __name__ == "__main__":
    unittest.main()
