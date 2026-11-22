"""Synthetic wire regressions, not a capture of the reported public Smash room."""
import io
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from protocol import parse_packet3
from collector import collect


def blob(raw):
    return struct.pack('>I',len(raw))+raw


def build_packet(game,title_id,versions,*,binary_headers=False,metadata=True):
    # Literal header structure, independently encoded from the production Reader.
    # Port 20668 and addresses include bytes invalid as standalone UTF-8.
    name=b'R\xa6' if binary_headers else b'Room'
    description=b'\xff\x00\xa6' if binary_headers else 'Sala de prueba'.encode()
    preferred=b'G\xa6' if binary_headers else game.encode()
    owner=b'O\xa6' if binary_headers else b'owner'
    wire=b'\x03'+blob(name)+blob(description)+struct.pack('>IH',32,20668)+blob(preferred)+blob(owner)+struct.pack('>I',len(versions))
    for index,version in enumerate(versions):
        nick=f'Player{index}'.encode()
        wire+=blob(nick)+bytes([10,166,255,index+1])+blob(game.encode())
        wire+=int(title_id,16).to_bytes(8,'big')+blob(version.encode())
        fields=(b'user-'+bytes([65+index]),'Jugador 🎮'.encode(),b'https://avatar.test/\xa6.png') if metadata else (b'',b'',b'')
        wire+=b''.join(blob(value) for value in fields)
    return wire


class GameProtocolTests(unittest.TestCase):
    def test_smash_versions_with_binary_header_ips_and_nonempty_account_fields(self):
        versions=['13.0.2','13.0.3','13.0.4','13.0.5','7.0.0']
        raw=build_packet('Super Smash Bros. Ultimate','01006A800016E000',versions,binary_headers=True)
        with self.assertRaises(UnicodeDecodeError):raw.decode('utf-8')
        result=parse_packet3(raw)
        self.assertEqual(result['port'],20668)
        self.assertEqual(result['max_players'],32)
        self.assertEqual(result['sala'],r'R\xa6')
        self.assertEqual([p['version'] for p in result['jugadores']],versions)
        self.assertEqual([p['virtual_ip'] for p in result['jugadores']],[f'10.166.255.{i}' for i in range(1,6)])
        self.assertEqual({p['title_id'] for p in result['jugadores']},{'01006A800016E000'})
        self.assertEqual({p['juego'] for p in result['jugadores']},{'Super Smash Bros. Ultimate'})

    def test_mario_kart_stays_compatible_with_empty_and_nonempty_metadata(self):
        for metadata in (False,True):
            with self.subTest(metadata=metadata):
                result=parse_packet3(build_packet('Mario Kart 8 Deluxe','0100152000022000',['4.0.1','4.0.1'],metadata=metadata))
                self.assertEqual(result['preferred_game'],'Mario Kart 8 Deluxe')
                self.assertEqual([p['version'] for p in result['jugadores']],['4.0.1','4.0.1'])
                self.assertEqual({p['title_id'] for p in result['jugadores']},{'0100152000022000'})

    def test_every_truncation_with_variable_metadata_is_rejected(self):
        raw=build_packet('Super Smash Bros. Ultimate','01006A800016E000',['13.0.5'],binary_headers=True)
        for offset in range(len(raw)):
            with self.subTest(offset=offset), self.assertRaises(ValueError):parse_packet3(raw[:offset])
        with self.assertRaises(ValueError):parse_packet3(raw+b'\x00')

    def test_corrupt_identity_is_not_silently_replaced_or_scanned_past(self):
        raw=build_packet('Super Smash Bros. Ultimate','01006A800016E000',['13.0.5'])
        raw=raw.replace(b'Player0',b'Pl\xa6yer0',1)
        with self.assertRaisesRegex(ValueError,r'players\[0\].nickname: invalid UTF-8 at packet offset'):
            parse_packet3(raw)

    def test_collector_emits_smash_snapshot_without_decoding_binary_packet_as_text(self):
        raw=build_packet('Super Smash Bros. Ultimate','01006A800016E000',['13.0.2','13.0.3','13.0.4','13.0.5','7.0.0'],binary_headers=True)
        process=MagicMock()
        process.stdout=[f'EDEN_PACKET3 {len(raw)} {raw.hex()}\n', 'sralcer: CONECTADO a la sala\n']
        process.wait.return_value=0;process.poll.return_value=0
        process.__enter__.return_value=process
        snapshots=[]
        with patch('collector.subprocess.Popen',return_value=process),patch('sys.stderr',new_callable=io.StringIO) as stderr:
            collect('unused',{'id':'smash-test','direccion':'127.0.0.1','puerto':20668},1,snapshots.append)
        self.assertEqual(stderr.getvalue(),'')
        self.assertEqual(len(snapshots[0]['jugadores']),5)
        self.assertEqual(snapshots[0]['jugadores'][-1]['version'],'7.0.0')
        self.assertNotIn('description',snapshots[0])

if __name__=='__main__':unittest.main()
