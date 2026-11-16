import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from protocol import parse_packet3
from collector import collect

FIXTURE = Path(__file__).parent / 'fixtures/packet3.hex'

def string(value):
    raw=value.encode()
    return struct.pack('>I',len(raw))+raw

def packet(players):
    data=b'\x03'+string('Room')+string('')+struct.pack('>IH',32,6007)+string('')+string('owner')+struct.pack('>I',len(players))
    for name,ip,game,version in players:
        data+=string(name)+bytes(ip)+string(game)+bytes.fromhex('0100770008DD8000')+string(version)+b'\0'*12
    return data

class ProtocolTests(unittest.TestCase):
    def test_supplied_layout_redacted(self):
        result=parse_packet3(bytes.fromhex(FIXTURE.read_text()))
        self.assertEqual(len(result['jugadores']),11)
        versions=[p['version'] for p in result['jugadores']]
        self.assertEqual(versions.count('1.4.0'),8)
        self.assertEqual(versions.count('1.0.0'),1)
        self.assertEqual(versions.count(''),2)
        self.assertEqual(result['jugadores'][0]['title_id'],'0100770008DD8000')

    def test_every_truncation_and_trailing_byte_rejected(self):
        raw=bytes.fromhex(FIXTURE.read_text())
        for end in range(len(raw)):
            with self.assertRaises((ValueError,UnicodeError)):
                parse_packet3(raw[:end])
        with self.assertRaises(ValueError):parse_packet3(raw+b'\0')

    def test_duplicates_preserved_and_empty_room(self):
        players=[('same',[10,0,0,1],'Game','1.0'),('same',[10,0,0,2],'Game','2.0')]
        self.assertEqual(len(parse_packet3(packet(players))['jugadores']),2)
        self.assertEqual(parse_packet3(packet([]))['jugadores'],[])
        players[1]=('same',[10,0,0,1],'Game','2.0')
        with self.assertRaises(ValueError):parse_packet3(packet(players))

    def test_collector_replaces_snapshots_and_excludes_itself(self):
        first=packet([('sralcer',[10,0,0,1],'',''),('Ana',[10,0,0,2],'Game','1.0')])
        empty=packet([])
        process=MagicMock()
        process.stdout=[f'EDEN_PACKET3 {len(raw)} {raw.hex()}\n' for raw in [first,empty]]
        process.wait.return_value=0
        process.poll.return_value=0
        process.__enter__.return_value=process
        snapshots=[]
        with patch('collector.subprocess.Popen',return_value=process):
            collect('unused',{'id':'room','direccion':'127.0.0.1','puerto':6007},1,snapshots.append)
        self.assertEqual([p['nombre'] for p in snapshots[0]['jugadores']],['Ana'])
        self.assertEqual(snapshots[1]['jugadores'],[])

    def test_custom_collector_name_is_forwarded_and_filtered(self):
        raw=packet([('custom_probe',[10,0,0,1],'',''),('Ana',[10,0,0,2],'Game','1.0')])
        process=MagicMock()
        process.stdout=[f'EDEN_PACKET3 {len(raw)} {raw.hex()}\n']
        process.wait.return_value=0
        process.poll.return_value=0
        process.__enter__.return_value=process
        snapshots=[]
        with patch('collector.subprocess.Popen',return_value=process) as launch:
            collect('unused',{'id':'room','direccion':'127.0.0.1','puerto':6007},1,snapshots.append,'custom_probe')
        self.assertEqual(launch.call_args.kwargs['env']['EDEN_ENET_NICKNAME'],'custom_probe')
        self.assertEqual([p['nombre'] for p in snapshots[0]['jugadores']],['Ana'])
        with self.assertRaises(ValueError):
            collect('unused',{},1,snapshots.append,'')

    def test_truncated_metadata_length_rejected(self):
        raw=packet([('Ana',[10,0,0,1],'Game','1.0')])
        with self.assertRaises(ValueError):parse_packet3(raw[:-1]+b'\x01')

    def test_unknown_version_text_and_empty_game_are_preserved(self):
        p=parse_packet3(packet([('A',[10,0,0,1],'','beta-1')]))['jugadores'][0]
        self.assertEqual(p['version'],'beta-1')
        self.assertEqual(p['juego'],'')

if __name__=='__main__':unittest.main()
