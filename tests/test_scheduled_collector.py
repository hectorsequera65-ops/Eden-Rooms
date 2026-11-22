"""Scheduled collection uses fixture targets and mocked HTTPS and ENet."""
from pathlib import Path
import io
import sys
from threading import Barrier
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import ApiError, PREVIEW_URL, RoomUnavailable, SCHEDULED_PATH, api, collect_public_rooms, main


def room(address, port=20668, protected=False):
    return dict(id=f"lobby-{address.replace('.', '-')}-{port}",
                direccion=address, puerto=port, hasPassword=protected)


class ScheduledCollectorTest(unittest.TestCase):
    def test_filters_targets_and_publishes_successes_despite_a_failed_room(self):
        first, second = room('8.8.8.8'), room('1.1.1.1')
        rooms = [first, first, second, room('9.9.9.9', protected=True),
                 room('127.0.0.1'), room('8.8.4.4', port=0),
                 dict(room('8.8.4.4'), id='wrong'), room('8.8.4.4', protected=None)]

        def transport(base, path, snapshot=None, *, timeout):
            self.assertEqual((base, path, timeout), ('https://example.test', SCHEDULED_PATH, 6))
            if snapshot is None:
                return {'storage': 'ENET_PREVIEW_DB', 'salas': rooms}
            self.assertEqual(snapshot, {'sala_id': second['id'], 'jugadores': []})
            return {'ok': True}

        def collect(binary, target, duration, emit, nickname, **options):
            self.assertEqual((binary, duration), ('fixture', 5))
            self.assertEqual(nickname, 'stunning' if target == first else 'smelly')
            self.assertEqual(options, {'hard_timeout': 7, 'first_snapshot': True})
            if target == first:
                raise RoomUnavailable('fixture timeout')
            emit({'sala_id': target['id'], 'jugadores': []})

        with patch('collector.api', side_effect=transport) as http, \
                patch('collector.collect', side_effect=collect) as enet, \
                patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                patch('sys.stderr', new_callable=io.StringIO) as stderr:
            self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), 0)
            self.assertCountEqual([call.args[1] for call in enet.call_args_list], [first, second])
            self.assertEqual(http.call_count, 2)
            self.assertIn('Published: 1/2', stdout.getvalue())
            self.assertIn('Unavailable rooms: 1; publication errors: 0; client errors: 0', stdout.getvalue())
            self.assertIn(f"Room unavailable {first['id']}: fixture timeout", stderr.getvalue())

    def test_assigns_full_cycle_in_room_order_with_concurrent_workers(self):
        rooms = [room('8.8.8.8', port=20668 + index) for index in range(14)]
        expected = [
            'stunning', 'smelly', 'ample', 'hideous', 'crazy', 'strong',
            'grubby', 'moist', 'scrummy', 'spiffing', 'greasy', 'amazing',
            'stunning', 'smelly',
        ]
        expected_by_id = dict(zip((target['id'] for target in rooms), expected))
        first_pair = Barrier(2)

        def collect(binary, target, duration, emit, nickname, **options):
            if target in rooms[:2]:
                first_pair.wait(timeout=5)
            self.assertEqual(nickname, expected_by_id[target['id']])

        with patch('collector.api', return_value={'storage': 'ENET_PREVIEW_DB', 'salas': rooms}), \
                patch('collector.collect', side_effect=collect) as enet, \
                patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), 0)
        self.assertCountEqual([call.args[1] for call in enet.call_args_list], rooms)

    def test_manual_rotation_continues_across_room_list_refreshes(self):
        first, second = room('8.8.8.8'), room('1.1.1.1')
        first['autorizada'] = second['autorizada'] = True
        skipped = dict(room('9.9.9.9'), autorizada=False)

        with patch.dict('os.environ', {}, clear=True), \
                patch('sys.argv', ['collector.py', '--base-url', 'https://example.test']), \
                patch('collector.api', return_value={'salas': [first, skipped, second]}), \
                patch('collector.collect') as enet, \
                patch('collector.time.sleep', side_effect=[None, KeyboardInterrupt]):
            with self.assertRaises(KeyboardInterrupt):
                main()
        self.assertEqual([(call.args[1], call.args[4]) for call in enet.call_args_list],
                         [(first, 'stunning'), (second, 'smelly'),
                          (first, 'ample'), (second, 'hideous')])

    def test_scheduled_client_failure_classification_never_publishes(self):
        target = room('8.8.8.8')
        cases = [
            (1, 'sin confirmacion de ingreso en 5 s', 0, 'Room unavailable'),
            (1, 'expulsado por el administrador', 0, 'Room unavailable'),
            (1, 'sala llena', 0, 'Room unavailable'),
            (0, 'CONECTADO a la sala', 0, 'No valid snapshots received'),
            (0, 'CONECTADO a la sala\nEDEN_PACKET3 1 03', 1, 'No compatible snapshot could be decoded'),
            (2, 'error de red local', 1, 'ENet client error'),
            (-9, '', 1, 'terminated by signal 9'),
        ]
        for status, diagnostic, expected, message in cases:
            with self.subTest(status=status, diagnostic=diagnostic):
                process = MagicMock()
                process.__enter__.return_value = process
                process.stdout = f'stunning: {diagnostic}\n'.splitlines(keepends=True) if diagnostic else []
                process.wait.return_value = process.poll.return_value = status
                with patch('collector.api', return_value={'storage': 'ENET_PREVIEW_DB', 'salas': [target]}) as http, \
                        patch('collector.subprocess.Popen', return_value=process), \
                        patch('sys.stdout', new_callable=io.StringIO), \
                        patch('sys.stderr', new_callable=io.StringIO) as stderr:
                    self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), expected)
                    self.assertIn(message, stderr.getvalue())
                    http.assert_called_once()

    def test_failed_posts_still_fail_with_other_successful_rooms(self):
        first, second = room('8.8.8.8'), room('1.1.1.1')

        def collect(binary, target, duration, emit, nickname, **options):
            emit({'sala_id': target['id'], 'jugadores': []})

        for failure in (ApiError('HTTP 401'), ApiError('network/TLS error'), {'ok': False}):
            with self.subTest(failure=failure):
                def transport(base, path, snapshot=None, *, timeout):
                    if snapshot is None:
                        return {'storage': 'ENET_PREVIEW_DB', 'salas': [first, second]}
                    if snapshot['sala_id'] == first['id']:
                        if isinstance(failure, ApiError):
                            raise failure
                        return failure
                    return {'ok': True}

                with patch('collector.api', side_effect=transport), \
                        patch('collector.collect', side_effect=collect), \
                        patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                        patch('sys.stderr', new_callable=io.StringIO) as stderr:
                    self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), 1)
                    self.assertIn('Published: 1/2', stdout.getvalue())
                    self.assertIn('publication errors: 1', stdout.getvalue())
                    self.assertIn(f"Publication failed for {first['id']}", stderr.getvalue())

    def test_missing_binary_fails(self):
        with patch('collector.api', return_value={'storage': 'ENET_PREVIEW_DB', 'salas': [room('8.8.8.8')]}), \
                patch('collector.subprocess.Popen', side_effect=FileNotFoundError), \
                patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(collect_public_rooms('https://example.test', 'fixture'), 1)
            self.assertIn('client errors: 1', stdout.getvalue())

    def test_room_list_authentication_failure_fails_cli_before_connecting(self):
        with patch.dict('os.environ', {'ENET_PREVIEW_API_KEY': 'fixture'}, clear=True), \
                patch('sys.argv', ['collector.py', '--base-url', PREVIEW_URL, '--scheduled']), \
                patch('collector.api', side_effect=ApiError('HTTP 403')), \
                patch('collector.collect') as enet, \
                patch('sys.stderr', new_callable=io.StringIO) as stderr:
            self.assertEqual(main(), 1)
            self.assertIn('HTTP 403', stderr.getvalue())
            enet.assert_not_called()

    def test_scheduled_http_refuses_other_origins_and_legacy_key(self):
        for base, credentials in (
            ('https://eden-rooms.pages.dev', {'ENET_PREVIEW_API_KEY': 'fixture'}),
            (PREVIEW_URL, {'VERSIONES_API_KEY': 'fixture'}),
        ):
            with self.subTest(base=base), patch.dict('os.environ', credentials, clear=True), \
                    patch('collector.urllib.request.build_opener') as opener:
                with self.assertRaises(ApiError):
                    api(base, SCHEDULED_PATH)
                opener.assert_not_called()

    def test_invalid_or_legacy_list_never_connects(self):
        for response in ({}, {'salas': [room('8.8.8.8')]}):
            with self.subTest(response=response), patch('collector.api', return_value=response) as http, \
                    patch('collector.collect') as enet:
                with self.assertRaises(ApiError):
                    collect_public_rooms('https://example.test', 'fixture')
                http.assert_called_once()
                enet.assert_not_called()
