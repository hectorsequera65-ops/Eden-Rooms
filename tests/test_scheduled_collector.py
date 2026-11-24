"""Scheduled collection uses fixture targets and mocked HTTPS and ENet."""
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import io
import sys
import time
from threading import Barrier, Lock
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend/enet'))
from collector import ApiError, PREVIEW_URL, PRODUCTION_URL, RoomUnavailable, SCHEDULED_PATH, api, collect_public_rooms, main, public_observation, replay_public_observations


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
            self.assertEqual((base, path, timeout), (PREVIEW_URL, SCHEDULED_PATH, 6))
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
            self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture'), 0)
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
            self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture'), 0)
        self.assertCountEqual([call.args[1] for call in enet.call_args_list], rooms)

    def test_manual_rotation_continues_across_room_list_refreshes(self):
        first, second = room('8.8.8.8'), room('1.1.1.1')
        first['autorizada'] = second['autorizada'] = True
        skipped = dict(room('9.9.9.9'), autorizada=False)

        with patch.dict('os.environ', {}, clear=True), \
                patch('sys.argv', ['collector.py', '--base-url', PREVIEW_URL]), \
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
                    self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture'), expected)
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
                    self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture'), 1)
                    self.assertIn('Published: 1/2', stdout.getvalue())
                    self.assertIn('publication errors: 1', stdout.getvalue())
                    self.assertIn(f"Publication failed for {first['id']}", stderr.getvalue())

    def test_shared_collection_keeps_public_samples_when_preview_posts_fail(self):
        # Force eight simultaneous room samples while rejecting any parallel peer
        # for the same room. Repeat across turns, with separate production writes.
        targets = [room('8.8.8.8', port=20668 + index) for index in range(16)]
        protected = room('9.9.9.9', protected=True)
        other = room('1.1.1.1')
        lock = Lock()
        active = set()
        production_posts = []
        preview_posts = []

        def collect(binary, target, duration, emit, nickname, **options):
            with lock:
                self.assertNotIn(target['id'], active)
                active.add(target['id'])
            wave.wait(timeout=5)
            with lock:
                active.remove(target['id'])
            emit(dict(sala_id=target['id'], consultado_en='2026-11-24T12:00:01Z',
                      private='discard', jugadores=[
                          dict(nombre='fixture', juego='Game', username='discard',
                               version='unknown\u0897' if target == targets[-1] else '1.2.3'),
                          dict(nombre='sralcer', version='9.9.9'),
                          dict(nombre='custom_probe', version='9.9.9')]))

        def transport(base, path, snapshot=None, *, timeout):
            if snapshot is None:
                if base == PREVIEW_URL:
                    return {'storage': 'ENET_PREVIEW_DB', 'salas': [*targets, targets[0], protected]}
                return {'storage': 'DB', 'salas': [*targets[1:], protected, other]}
            if base == PREVIEW_URL:
                preview_posts.append(snapshot)
                raise ApiError('HTTP 503')
            if path.endswith('?reserve'):
                if snapshot['slot'] in reserved:
                    raise ApiError('HTTP 409')
                reserved.add(snapshot['slot'])
                return {'reserved': True}
            self.assertIn(snapshot['slot'], reserved)
            production_posts.append(snapshot)
            return {'ok': True}

        reserved = set()
        with TemporaryDirectory() as tmp, patch('collector.api', side_effect=transport), \
                patch('collector.collect', side_effect=collect) as enet, \
                patch('sys.stdout', new_callable=io.StringIO), \
                patch('sys.stderr', new_callable=io.StringIO):
            for slot in (300000, 600000, 900000):
                wave = Barrier(8)
                handoff = Path(tmp) / f'{slot}.json'
                self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture', export=handoff,
                                                      excluded_nickname='custom_probe'), 1)
                expected = [
                    dict(sala_id=target['id'], consultado_en='2026-11-24T12:00:01Z',
                         jugadores=[dict(nombre='fixture', juego='Game', version='1.2.3')])
                    for target in targets[:-1]
                ]
                self.assertEqual(json.loads(handoff.read_text()), expected)
                self.assertEqual(replay_public_observations(handoff, slot), 0)
                with self.assertRaisesRegex(ApiError, 'HTTP 409'):
                    replay_public_observations(handoff, slot)
                self.assertCountEqual([post for post in production_posts if post['slot'] == slot],
                                      [dict(sample, slot=slot) for sample in expected[1:]])
            self.assertCountEqual([call.args[1] for call in enet.call_args_list], targets * 3)
            self.assertEqual(len(preview_posts), 48)
            self.assertTrue(all('slot' not in post for post in preview_posts))

    def test_shared_pipeline_keeps_early_samples_fresh_under_load(self):
        # Each simulated second is 10 ms. Enforce expiry at POST arrival,
        # including the artifact transfer and both production setup calls.
        for count, sample_seconds in ((80, 7), (88, 6)):
            with self.subTest(count=count):
                targets = [room('8.8.8.8', port=20668 + index) for index in range(count)]
                posts = {PREVIEW_URL: [], PRODUCTION_URL: []}
                first_wave = Barrier(8)

                def collect(binary, target, duration, emit, nickname, **options):
                    if target in targets[:8]:
                        first_wave.wait(timeout=5)
                    time.sleep(sample_seconds / 100)
                    emit(dict(sala_id=target['id'],
                              consultado_en=datetime.now(timezone.utc).isoformat(),
                              jugadores=[dict(nombre='Player', version='1.2.3')]))

                def transport(base, path, snapshot=None, *, timeout):
                    if snapshot is None:
                        if base == PRODUCTION_URL:
                            time.sleep(.06)
                        return {'storage': 'DB' if base == PRODUCTION_URL else 'ENET_PREVIEW_DB',
                                'salas': targets}
                    if path.endswith('?reserve'):
                        time.sleep(.06)
                        return {'reserved': True}
                    observed = datetime.fromisoformat(snapshot['consultado_en'])
                    age = (datetime.now(timezone.utc) - observed).total_seconds()
                    if age > 1.20:
                        raise ApiError('HTTP 400')
                    time.sleep(.06)
                    posts[base].append((snapshot['sala_id'], snapshot['consultado_en']))
                    return {'ok': True}

                with TemporaryDirectory() as tmp, patch('collector.api', side_effect=transport), \
                        patch('collector.collect', side_effect=collect) as enet:
                    handoff = Path(tmp) / 'observations.json'
                    self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture', export=handoff), 0)
                    time.sleep(.05)
                    self.assertEqual(replay_public_observations(handoff, 300000), 0)
                    self.assertCountEqual([call.args[1] for call in enet.call_args_list], targets)
                    self.assertCountEqual([room_id for room_id, _ in posts[PREVIEW_URL]],
                                          [target['id'] for target in targets])
                    self.assertCountEqual(posts[PRODUCTION_URL], posts[PREVIEW_URL])

    def test_export_filter_defaults_to_pages_nickname_and_allows_override(self):
        for override, expected in (({}, 'sralcer'),
                                   ({'EDEN_ENET_PREVIEW_EXCLUDED_NICKNAME': 'custom_probe'}, 'custom_probe')):
            with self.subTest(override=override), \
                    patch.dict('os.environ', {'ENET_PREVIEW_API_KEY': 'fixture', **override}, clear=True), \
                    patch('sys.argv', ['collector.py', '--base-url', PREVIEW_URL, '--scheduled',
                                       '--export-observations', 'fixture.json']), \
                    patch('collector.collect_public_rooms', return_value=0) as collect:
                self.assertEqual(main(), 0)
                collect.assert_called_once_with(PREVIEW_URL, '/opt/eden-rooms-enet/eden-collector',
                                                None, 'fixture.json', excluded_nickname=expected)

    def test_public_observation_version_matches_known_version(self):
        for version, known in (('\ufeff', False), ('\ufeffunknown\ufeff', False),
                               ('Versión\ufeffdesconocida', False), ('\ufeff1.2.3\ufeff', True),
                               ('unknown\x85', True), ('\u0301', True),
                               ('unknown\u0897', False), ('\ufeffunknown\u0897\ufeff', False),
                               ('1.2.3\u0897', True)):
            with self.subTest(version=version):
                snapshot = dict(sala_id='fixture', consultado_en='2026-11-24T12:00:01Z',
                                jugadores=[dict(nombre='Player', version=version),
                                           dict(nombre='sralcer', version='9.9.9')])
                observation = public_observation(snapshot)
                self.assertEqual(observation is not None, known)
                if known:
                    self.assertEqual(observation['jugadores'], snapshot['jugadores'][:1])

    def test_production_only_samples_and_publishes_after_reservation(self):
        target = room('8.8.8.8')
        slot = 300000
        with patch('collector.api', side_effect=[
                {'storage': 'DB', 'salas': [target]}, {'reserved': True}, {'ok': True}
             ]) as http, patch('collector.collect') as enet, patch('sys.stdout', new_callable=io.StringIO):
            def collect(binary, room, duration, emit, nickname, **options):
                self.assertEqual(http.call_args.args, (PRODUCTION_URL, SCHEDULED_PATH + '?reserve', {'slot': slot}))
                emit({'sala_id': room['id'], 'jugadores': []})
            enet.side_effect = collect
            self.assertEqual(collect_public_rooms(PRODUCTION_URL, 'fixture', slot), 0)
            enet.assert_called_once()
            self.assertEqual(http.call_args.args, (
                PRODUCTION_URL, SCHEDULED_PATH, {'sala_id': target['id'], 'jugadores': [], 'slot': slot},
            ))

    def test_missing_binary_fails(self):
        with patch('collector.api', return_value={'storage': 'ENET_PREVIEW_DB', 'salas': [room('8.8.8.8')]}), \
                patch('collector.subprocess.Popen', side_effect=FileNotFoundError), \
                patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(collect_public_rooms(PREVIEW_URL, 'fixture'), 1)
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
                    collect_public_rooms(PREVIEW_URL, 'fixture')
                http.assert_called_once()
                enet.assert_not_called()

    def test_production_reserves_before_enet_and_rejects_preview_storage(self):
        for response in (
            {'storage': 'ENET_PREVIEW_DB', 'salas': [room('8.8.8.8')]},
            {'storage': 'DB', 'salas': [room('8.8.8.8')]},
        ):
            with self.subTest(response=response), \
                    patch('collector.api', side_effect=[response, ApiError('HTTP 409')]) as http, \
                    patch('collector.collect') as enet:
                with self.assertRaises(ApiError):
                    collect_public_rooms(PRODUCTION_URL, 'fixture', 300000)
                enet.assert_not_called()
                self.assertEqual(http.call_count, 2 if response['storage'] == 'DB' else 1)
                if http.call_count == 2:
                    self.assertEqual(http.call_args.args, (PRODUCTION_URL, SCHEDULED_PATH + '?reserve', {'slot': 300000}))
