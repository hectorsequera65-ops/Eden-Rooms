from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend/enet'))
from collector import SnapshotPublisher,ApiError,main

class PublisherTests(unittest.TestCase):
    def test_changes_send_immediately_duplicates_wait_for_heartbeat(self):
        clock=[0]
        transport=MagicMock(return_value={'ok':True})
        publisher=SnapshotPublisher('https://preview.test',transport=transport,now=lambda:clock[0])
        snapshot={'sala_id':'room','consultado_en':'first','jugadores':[{'nombre':'Eden','version':'4.0.1'},{'nombre':'SataHT','version':'4.0.1'}]}
        self.assertTrue(publisher(snapshot))
        self.assertFalse(publisher({**snapshot,'consultado_en':'later','jugadores':list(reversed(snapshot['jugadores']))}))
        clock[0]=59;self.assertFalse(publisher(snapshot))
        clock[0]=60;self.assertTrue(publisher(snapshot))
        clock[0]=61;self.assertTrue(publisher({**snapshot,'jugadores':[]}))
        self.assertEqual(transport.call_count,3)
        self.assertEqual(transport.call_args.args[1],'/api/versiones-multiples')

    def test_failure_does_not_suppress_next_attempt(self):
        transport=MagicMock(side_effect=[ApiError('failed'),{'ok':True}])
        publisher=SnapshotPublisher('https://preview.test',transport=transport,now=lambda:0)
        snapshot={'sala_id':'room','jugadores':[]}
        with self.assertRaises(ApiError):publisher(snapshot)
        self.assertTrue(publisher(snapshot));self.assertEqual(transport.call_count,2)

    def test_empty_configured_room_id_cannot_query_every_room(self):
        with patch('sys.argv',['collector.py','--base-url','https://preview.test','--room-id','','--once']), patch('collector.collect') as connect, patch('sys.stderr'):
            with self.assertRaises(SystemExit) as caught:main()
            self.assertEqual(caught.exception.code,2)
            connect.assert_not_called()

    def test_validation_never_uses_write_route(self):
        transport=MagicMock(return_value={'validado':True,'escritura':False})
        publisher=SnapshotPublisher('https://preview.test',True,transport=transport)
        with patch('builtins.print'):publisher({'sala_id':'room','jugadores':[]})
        self.assertEqual(transport.call_args.args[1],'/api/versiones-validar')

if __name__=='__main__':unittest.main()
