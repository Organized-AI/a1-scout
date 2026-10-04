"""Eject / mount requests from the dashboard, carried out by the heartbeat.

    cd ~/nvme-stash/a1-scout && python3 -m unittest tests.test_drive -v
diskutil and the site API are faked: nothing here touches a real disk.
"""
import sys, unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import agent as A  # noqa: E402


class Drive(unittest.TestCase):
    def setUp(self):
        self.calls, self.acks, self.mounted = [], [], True
        self._sh, self._api, self._present, self._log = A.sh, A.api, A.a1_present, A.log
        A.ENV.setdefault("A1_UUID", "UUID-1")

        def sh(args, timeout=None, **kw):
            self.calls.append(args)
            if args[:2] == ["diskutil", "unmount"]:
                self.mounted = False
            if args[:2] == ["diskutil", "mount"]:
                self.mounted = True
            if args[:2] == ["diskutil", "info"]:
                return SimpleNamespace(returncode=0, stdout=f"   Mounted:                   {'Yes' if self.mounted else 'No'}\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        A.sh = sh
        A.api = lambda path, method="GET", body=None, raw=False: self.acks.append((path, body)) or {}
        A.a1_present = lambda: self.mounted
        A.log = lambda *a, **k: None

    def tearDown(self):
        A.sh, A.api, A.a1_present, A.log = self._sh, self._api, self._present, self._log

    def test_eject_unmounts_and_never_ejects_the_device(self):
        A.drive_request({"action": "eject"}, present=True, busy=False)
        self.assertIn(["diskutil", "unmount", str(A.MOUNT)], self.calls)
        self.assertFalse(any(c[:2] == ["diskutil", "eject"] for c in self.calls))
        self.assertEqual(self.acks[-1][1]["state"], "done")

    def test_eject_refused_mid_run(self):
        A.drive_request({"action": "eject"}, present=True, busy=True)
        self.assertFalse(any(c[:2] == ["diskutil", "unmount"] for c in self.calls))
        self.assertEqual(self.acks[-1][1]["state"], "busy")

    def test_mount_uses_the_volume_uuid(self):
        self.mounted = False
        A.drive_request({"action": "mount"}, present=False, busy=False)
        self.assertIn(["diskutil", "mount", A.ENV["A1_UUID"]], self.calls)
        self.assertEqual(self.acks[-1][1]["state"], "done")

    def test_mount_when_disconnected_is_absent(self):
        self.mounted = False
        A.sh = lambda args, timeout=None, **kw: SimpleNamespace(returncode=1, stdout="", stderr="Could not find disk")
        A.drive_request({"action": "mount"}, present=False, busy=False)
        self.assertEqual(self.acks[-1][1]["state"], "absent")

    def test_unknown_action_does_nothing(self):
        A.drive_request({"action": "erase"}, present=True, busy=False)
        self.assertFalse(any(c[0] == "diskutil" for c in self.calls))
        self.assertEqual(self.acks[-1][1]["state"], "failed")


if __name__ == "__main__":
    unittest.main()
