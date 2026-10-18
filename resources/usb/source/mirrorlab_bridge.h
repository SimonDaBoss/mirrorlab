// SPDX-License-Identifier: GPL-3.0-or-later
// Native helpers use a reliable, length-delimited localhost stream. Never drop
// reference pictures between the receiver and decoder to reduce preview latency.
#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <mutex>

static SOCKET mirrorlab_socket = INVALID_SOCKET;
static std::mutex mirrorlab_media_mutex;
static bool mirrorlab_bridge_enabled() { return getenv("MIRRORLAB_MEDIA_PORT") != nullptr; }
static bool mirrorlab_send_all(const unsigned char* p, int size) {
    while (size > 0) {
        int n = send(mirrorlab_socket, (const char*)p, size, 0);
        if (n <= 0) { closesocket(mirrorlab_socket); mirrorlab_socket = INVALID_SOCKET; return false; }
        p += n; size -= n;
    }
    return true;
}
static bool mirrorlab_send_media(uint32_t kind, uint32_t argument, uint64_t pts_us, const void* data, uint32_t size) {
    if (!size || size > 16 * 1024 * 1024) return false;
    std::lock_guard<std::mutex> guard(mirrorlab_media_mutex);
    if (mirrorlab_socket == INVALID_SOCKET) {
        const char* port = getenv("MIRRORLAB_MEDIA_PORT");
        if (!port) return false;
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2,2), &wsa)) return false;
        mirrorlab_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        sockaddr_in address{}; address.sin_family = AF_INET;
        address.sin_port = htons((unsigned short)atoi(port)); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (connect(mirrorlab_socket, (sockaddr*)&address, sizeof(address))) {
            closesocket(mirrorlab_socket); mirrorlab_socket = INVALID_SOCKET; return false;
        }
        int enabled = 1; setsockopt(mirrorlab_socket, IPPROTO_TCP, TCP_NODELAY, (char*)&enabled, sizeof(enabled));
        DWORD timeout = 2000; setsockopt(mirrorlab_socket, SOL_SOCKET, SO_SNDTIMEO, (char*)&timeout, sizeof(timeout));
    }
    unsigned char header[24] = {'M','L','B','1'};
    memcpy(header + 4, &size, 4); memcpy(header + 8, &kind, 4);
    memcpy(header + 12, &argument, 4); memcpy(header + 16, &pts_us, 8);
    return mirrorlab_send_all(header, sizeof(header)) && mirrorlab_send_all((const unsigned char*)data, (int)size);
}
