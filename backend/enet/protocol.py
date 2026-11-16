"""Strict packet-3 layout inferred from the supplied Termux capture."""
import ipaddress


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def take(self, size):
        if size < 0 or self.offset + size > len(self.data):
            raise ValueError('Truncated packet')
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def integer(self, size=4):
        return int.from_bytes(self.take(size), 'big')

    def blob(self, limit=4096):
        size = self.integer()
        if size > limit:
            raise ValueError('Oversized field')
        return self.take(size)

    def string(self, limit=4096):
        return self.blob(limit).decode('utf-8')


def parse_packet3(data):
    r = Reader(data)
    if r.integer(1) != 3:
        raise ValueError('Not packet 3')
    name, description = r.string(), r.string()
    maximum, port = r.integer(), r.integer(2)
    preferred, owner = r.string(), r.string()
    count = r.integer()
    if count > 256:
        raise ValueError('Too many members')
    players = []
    for _ in range(count):
        nickname = r.string(80)
        address = str(ipaddress.IPv4Address(r.take(4)))
        game = r.string(160)
        title_id = f'{r.integer(8):016X}'
        version = r.string(40)
        # Only the captured variant is established: 12 zero bytes per player.
        # Could be three empty fields; reject other layouts instead of guessing.
        if r.take(12) != bytes(12):
            raise ValueError('Unsupported nonempty player metadata')
        players.append(dict(nombre=nickname, virtual_ip=address, juego=game,
                            title_id=title_id, version=version))
    if r.offset != len(data):
        raise ValueError('Unexpected packet tail/layout')
    if len({p['virtual_ip'] for p in players}) != count:
        raise ValueError('Duplicate virtual IP in snapshot')
    return dict(sala=name, description=description, max_players=maximum,
                port=port, preferred_game=preferred, owner=owner, jugadores=players)
