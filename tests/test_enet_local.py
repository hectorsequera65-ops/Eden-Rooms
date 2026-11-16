"""Optional integration test against a local fixture server, never public rooms."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import collect

class LocalENetTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('EDEN_TEST_CLIENT') and os.environ.get('EDEN_TEST_SERVER'), 'Set compiled local ENet test binaries')
    def test_handshake_and_snapshot(self):
        fixture=Path(__file__).parent/'fixtures/packet3.hex'
        with subprocess.Popen([os.environ['EDEN_TEST_SERVER'],str(fixture)],stdout=subprocess.PIPE,text=True) as server:
            try:
                port=int(server.stdout.readline())
                snapshots=[]
                collect(os.environ['EDEN_TEST_CLIENT'],{'id':'local','direccion':'127.0.0.1','puerto':port},2,snapshots.append)
                self.assertEqual(server.wait(timeout=5),0)
                self.assertEqual(len(snapshots),1)
                self.assertEqual(len(snapshots[0]['jugadores']),11)
                self.assertEqual(snapshots[0]['jugadores'][0]['title_id'],'0100770008DD8000')
            finally:
                if server.poll() is None:
                    server.kill();server.wait()

if __name__=='__main__':unittest.main()
