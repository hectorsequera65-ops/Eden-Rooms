// SPDX-License-Identifier: MIT
// Independent test client for Eden room protocol version 1.
#include <enet/enet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <stdint.h>
#include <time.h>

static const char *names[1] = {"sralcer"};
static volatile sig_atomic_t stop_requested;
static void stop_handler(int sig) { (void)sig; stop_requested = 1; }
static uint64_t now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static int number(const char *s, long lo, long hi) {
    char *end; long n = strtol(s, &end, 10);
    return *s && !*end && n >= lo && n <= hi ? (int)n : -1;
}
static void u32(unsigned char *p, uint32_t v) {
    p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}
static int join_room(ENetPeer *peer, int index, const char *password) {
    const char *name = names[index];
    unsigned char buf[512]; size_t pos = 0, n = strlen(name), pw = strlen(password);
    buf[pos++] = 1; // IdJoinRequest
    u32(buf + pos, (uint32_t)n); pos += 4;
    memcpy(buf + pos, name, n); pos += n;
    memset(buf + pos, 255, 4); pos += 4; // automatically assigned fake IP
    u32(buf + pos, 1); pos += 4; // Eden network_version
    u32(buf + pos, (uint32_t)pw); pos += 4;
    memcpy(buf + pos, password, pw); pos += pw;
    u32(buf + pos, 0); pos += 4; // empty verification token
    ENetPacket *packet = enet_packet_create(buf, pos, ENET_PACKET_FLAG_RELIABLE);
    if (!packet) return -1;
    if (enet_peer_send(peer, 0, packet) < 0) { enet_packet_destroy(packet); return -1; }
    return 0;
}
static const char *reason(unsigned char id) {
    switch (id) {
    case 8: return "nombre ocupado o rechazado";
    case 9: return "conflicto de IP virtual";
    case 10: return "version de protocolo incompatible";
    case 11: return "contrasena incorrecta";
    case 12: return "sala cerrada";
    case 13: return "sala llena";
    case 15: return "expulsado por el administrador";
    case 16: return "bloqueado por el administrador";
    default: return NULL;
    }
}
int main(int argc, char **argv) {
    if (argc < 3 || argc > 6) {
        fprintf(stderr, "Uso: %s HOST PUERTO [USUARIOS=1] [SEGUNDOS=300] [CONTRASENA]\n", argv[0]);
        return 2;
    }
    const char *nickname = getenv("EDEN_ENET_NICKNAME");
    if (!nickname) nickname = "sralcer";
    size_t nickname_len = strlen(nickname);
    if (nickname_len < 1 || nickname_len > 24 ||
        strspn(nickname, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != nickname_len) {
        fputs("EDEN_ENET_NICKNAME invalido: usa 1-24 caracteres A-Z, a-z, 0-9, _ o -.\n", stderr);
        return 2;
    }
    names[0] = nickname;
    int port = number(argv[2], 1, 65535);
    int count = argc > 3 ? number(argv[3], 1, 1) : 1;
    int duration = argc > 4 ? number(argv[4], 1, 600) : 300;
    const char *password = argc > 5 ? argv[5] : "";
    if (port < 0 || count < 0 || duration < 0 || strlen(password) > 255) {
        fputs("Parametros invalidos: usuarios 1, segundos 1-600, puerto 1-65535.\n", stderr);
        return 2;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (enet_initialize() < 0) return 1;
    ENetAddress address = {0}; address.port = (enet_uint16)port;
    if (enet_address_set_host(&address, argv[1]) < 0) {
        fputs("No se pudo resolver el servidor.\n", stderr); enet_deinitialize(); return 1;
    }
    ENetHost *hosts[1] = {0};
    signal(SIGINT, stop_handler); signal(SIGTERM, stop_handler);
    ENetPeer *peers[1] = {0};
    int state[1] = {0}, ever[1] = {0}; // 0 waiting, 1 connecting, 2 joined, 3 ended
    uint64_t sent[1] = {0};
    int started = 0, failed = 0;
    uint64_t start = now_ms(), next = start;
    printf("Destino: %s:%d | Usuarios: %d | Duracion: %d s\n", argv[1], port, count, duration);
    puts("Eden Rooms collector: one connection, no game announcement.");
    puts("Ctrl+C desconecta todos. Sin reintentos automaticos ni mensajes de chat.");
    while (!stop_requested && now_ms() - start < (uint64_t)duration * 1000) {
        uint64_t now = now_ms();
        if (started < count && now >= next) {
            int i = started++;
            hosts[i] = enet_host_create(NULL, 1, 1, 0, 0);
            peers[i] = hosts[i] ? enet_host_connect(hosts[i], &address, 1, 0) : NULL;
            state[i] = peers[i] ? 1 : 3; sent[i] = now;
            printf("%s: %s\n", names[i], peers[i] ? "conectando..." : "no se pudo crear la conexion");
            if (!peers[i]) failed = 1;
            next = now + 10000;
        }
        for (int i = 0; i < started; ++i) {
            if (!hosts[i]) continue;
            ENetEvent event;
            int result = enet_host_service(hosts[i], &event, 0);
            if (result < 0) {
                if (state[i] != 3) printf("%s: error de red local\n", names[i]);
                state[i] = 3; failed = 1; continue;
            }
            if (result == 0) continue;
            if (state[i] != 3) {
                if (event.type == ENET_EVENT_TYPE_CONNECT) {
                    if (join_room(event.peer, i, password) < 0) {
                        state[i] = 3; failed = 1; enet_peer_reset(event.peer);
                        printf("%s: no se pudo enviar la solicitud\n", names[i]);
                    }
                } else if (event.type == ENET_EVENT_TYPE_RECEIVE && event.packet->dataLength) {
                    unsigned char id = event.packet->data[0];
                    if (id == 3) {
                        printf("EDEN_PACKET3 %zu ", event.packet->dataLength);
                        for (size_t k=0; k<event.packet->dataLength; ++k)
                            printf("%02x", (unsigned)event.packet->data[k]);
                        putchar('\n');
                    }
                    if (id == 2 || id == 24) {
                        if (state[i] != 2) {
                            printf("%s: CONECTADO a la sala\n", names[i]);

                        }
                        state[i] = 2; ever[i] = 1;
                    } else if (reason(id)) {
                        printf("%s: %s\n", names[i], reason(id));
                        state[i] = 3; failed = 1; enet_peer_disconnect(event.peer, 0);
                    }
                } else if (event.type == ENET_EVENT_TYPE_DISCONNECT) {
                    printf("%s: desconectado por el servidor o la red\n", names[i]);
                    state[i] = 3; failed = 1;
                }
            }
            if (event.type == ENET_EVENT_TYPE_RECEIVE) enet_packet_destroy(event.packet);
        }
        int active = 0;
        for (int i = 0; i < started; ++i) {
            if (state[i] == 1 && now_ms() - sent[i] >= 15000) {
                printf("%s: sin confirmacion de ingreso en 15 s\n", names[i]);
                state[i] = 3; failed = 1; enet_peer_reset(peers[i]);
            }
            active += state[i] == 1 || state[i] == 2;
        }
        if (started == count && !active) break;
        struct timespec pause = {0, 10000000};
        nanosleep(&pause, NULL);
    }
    int joined = 0;
    for (int i = 0; i < started; ++i) {
        joined += ever[i];
        if (peers[i]) enet_peer_disconnect(peers[i], 0);
    }
    for (int i = 0; i < started; ++i)
        if (hosts[i]) enet_host_flush(hosts[i]);
    uint64_t end = now_ms() + 1000;
    while (now_ms() < end) {
        for (int i = 0; i < started; ++i) {
            ENetEvent event;
            if (hosts[i] && enet_host_service(hosts[i], &event, 0) > 0 &&
                event.type == ENET_EVENT_TYPE_RECEIVE) enet_packet_destroy(event.packet);
        }
        struct timespec pause = {0, 10000000};
        nanosleep(&pause, NULL);
    }
    for (int i = 0; i < started; ++i)
        if (hosts[i]) enet_host_destroy(hosts[i]);
    enet_deinitialize();
    printf("Finalizado. Ingresaron %d de %d usuarios solicitados. Conexiones cerradas.\n", joined, count);
    return failed || joined != count ? 1 : 0;
}
