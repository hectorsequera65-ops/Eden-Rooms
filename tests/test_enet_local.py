"""Optional integration test against a local fixture server, never public rooms."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import RoomUnavailable, collect

class LocalENetTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('EDEN_TEST_CLIENT') and os.environ.get('EDEN_TEST_SERVER'), 'Set compiled local ENet test binaries')
    def test_handshake_and_snapshot(self):
        for first_snapshot in (False, True):
            with self.subTest(first_snapshot=first_snapshot):
                self.check_handshake(first_snapshot)

    @unittest.skipUnless(os.environ.get('EDEN_TEST_CLIENT') and os.environ.get('EDEN_TEST_SERVER'), 'Set compiled local ENet test binaries')
    def test_protocol_rejection_reports_server_version_without_publishing(self):
        fixture = Path(__file__).parent / 'fixtures/packet3.hex'
        command = [os.environ['EDEN_TEST_SERVER'], str(fixture), 'mismatch']
        with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as server:
            try:
                port = int(server.stdout.readline())
                snapshots = []
                with self.assertRaisesRegex(RoomUnavailable, r'cliente 1, servidor 258'):
                    collect(os.environ['EDEN_TEST_CLIENT'],
                            {'id': 'local', 'direccion': '127.0.0.1', 'puerto': port},
                            2, snapshots.append, hard_timeout=4)
                self.assertEqual(snapshots, [])
                self.assertEqual(server.wait(timeout=5), 0)
            finally:
                if server.poll() is None:
                    server.kill()
                    server.wait()

    def check_handshake(self, first_snapshot):
        fixture=Path(__file__).parent/'fixtures/packet3.hex'
        with subprocess.Popen([os.environ['EDEN_TEST_SERVER'],str(fixture)],stdout=subprocess.PIPE,text=True) as server:
            try:
                port=int(server.stdout.readline())
                snapshots=[]
                collect(os.environ['EDEN_TEST_CLIENT'],
                        {'id':'local','direccion':'127.0.0.1','puerto':port},
                        2, snapshots.append, first_snapshot=first_snapshot, hard_timeout=4)
                self.assertEqual(server.wait(timeout=5),0)
                self.assertEqual(len(snapshots),1)
                self.assertEqual(len(snapshots[0]['jugadores']),11)
                self.assertEqual(snapshots[0]['jugadores'][0]['title_id'],'0100770008DD8000')
            finally:
                if server.poll() is None:
                    server.kill();server.wait()

if __name__=='__main__':unittest.main()
