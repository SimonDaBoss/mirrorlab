// SPDX-License-Identifier: GPL-3.0-or-later
// Separate USB QuickTime host; protocol and transport are from iPhoneMirror.
//
// Capture uses iPhoneMirror's libusb-win32 (libusb0) per-device UpperFilter
// backend. Apple's usbccgp/usbaapl stack stays in place, and the filter can
// select the hidden QuickTime configuration (5 on current iPhones). UsbDk is
// not used: it builds its pipe table from configuration 1 only, so it can
// never reach the QuickTime endpoints.
#include "mirrorlab_bridge.h"
#include <windows.h>
#include <cfgmgr32.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <stop_token>
#include <fstream>
#include <thread>
#include <vector>
#include "Transport/LibUsb0Transport.h"
#include "Protocol/QuickTimeSession.h"
#include "Media/H264.h"
#include "Logging.h"
#include "Transport/UsbMuxClient.h"

namespace tr = iPhoneMirror::transport;
namespace qt = iPhoneMirror::quicktime;
namespace cm = iPhoneMirror::coremedia;
static std::atomic_bool stopping{false};
static std::stop_source stop_source; // cancels waits inside the transport
static BOOL WINAPI on_ctrl(DWORD) { stopping = true; return TRUE; }

static std::string json_string(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '\"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { char escaped[7]; snprintf(escaped, sizeof escaped, "\\u%04x", c); out += escaped; }
        else out += c;
    }
    return out + "\"";
}

static std::string upper_serial(std::string_view serial) {
    std::string out;
    for (unsigned char c : serial) if (c != '-' && !std::isspace(c)) out += static_cast<char>(std::toupper(c));
    return out;
}

static std::string upper(std::string s) {
    std::ranges::transform(s, s.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return s;
}

// Open-free driver state from the PnP tree: never opens the phone, so it is
// safe to poll while the launcher refreshes.
struct DriverState {
    std::string instance_id;
    std::string service;
    bool present{};
    bool filter{};     // libusb0 is in the parent's UpperFilters
    bool attached{};   // libusb0 has published its device interface for it
};

static std::vector<std::string> multi_sz(DEVINST node, ULONG property) {
    ULONG size = 0;
    std::vector<std::string> result;
    if (CM_Get_DevNode_Registry_PropertyA(node, property, nullptr, nullptr, &size, 0) != CR_BUFFER_SMALL || !size) return result;
    std::vector<char> buffer(size + 2, '\0');
    if (CM_Get_DevNode_Registry_PropertyA(node, property, nullptr, buffer.data(), &size, 0) != CR_SUCCESS) return result;
    for (const char* p = buffer.data(); *p; p += strlen(p) + 1) result.emplace_back(p);
    return result;
}

static DriverState driver_state(const std::string& serial) {
    DriverState state;
    const auto wanted = upper_serial(serial);
    if (wanted.empty()) return state;
    ULONG length = 0;
    const ULONG flags = CM_GETIDLIST_FILTER_ENUMERATOR | CM_GETIDLIST_FILTER_PRESENT;
    if (CM_Get_Device_ID_List_SizeA(&length, "USB", flags) != CR_SUCCESS || length < 2) return state;
    std::vector<char> ids(length, '\0');
    if (CM_Get_Device_ID_ListA("USB", ids.data(), length, flags) != CR_SUCCESS) return state;
    for (const char* p = ids.data(); *p; p += strlen(p) + 1) {
        const auto id = upper(p);
        if (!id.starts_with("USB\\VID_05AC&PID_") || id.find("&MI_") != std::string::npos) continue;
        const auto slash = id.rfind('\\');
        if (slash == std::string::npos || id.substr(slash + 1) != wanted) continue;
        DEVINST node{};
        if (CM_Locate_DevNodeA(&node, const_cast<char*>(p), CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS) continue;
        state.instance_id = p;
        state.present = true;
        for (const auto& f : multi_sz(node, CM_DRP_UPPERFILTERS)) if (upper(f) == "LIBUSB0") state.filter = true;
        char service[256]{}; ULONG size = sizeof(service);
        if (CM_Get_DevNode_Registry_PropertyA(node, CM_DRP_SERVICE, nullptr, service, &size, 0) == CR_SUCCESS) state.service = service;
        break;
    }
    // libusb-win32 device interface: \\?\USB#VID_05AC&PID_xxxx#<serial>#{F9F3FF14-...}
    static GUID libusb0_interface{0xF9F3FF14, 0xAE21, 0x48A0, {0x8A, 0x25, 0x80, 0x11, 0xA7, 0xA9, 0x31, 0xD9}};
    if (state.filter && CM_Get_Device_Interface_List_SizeA(&length, &libusb0_interface, nullptr, CM_GET_DEVICE_INTERFACE_LIST_PRESENT) == CR_SUCCESS && length > 1) {
        std::vector<char> paths(length, '\0');
        if (CM_Get_Device_Interface_ListA(&libusb0_interface, nullptr, paths.data(), length, CM_GET_DEVICE_INTERFACE_LIST_PRESENT) == CR_SUCCESS)
            for (const char* p = paths.data(); *p; p += strlen(p) + 1) {
                const auto path = upper(p);
                if (path.find("VID_05AC") != std::string::npos && path.find("#" + wanted + "#") != std::string::npos) state.attached = true;
            }
    }
    return state;
}

static const char* driver_label(const DriverState& d) {
    if (d.filter && d.attached && tr::libusb0_installed()) return "ready";
    if (d.filter) return "replug";
    return "missing";
}

static std::string device_value(tr::UsbMuxClient& mux, uint32_t id, const char* key) {
    namespace pl = iPhoneMirror::plist;
    auto socket = mux.connect_device(id, 62078);
    auto xml = pl::to_xml(pl::Value::Dict({{"Label", pl::Value::String("Mirrorlab")}, {"Request", pl::Value::String("GetValue")}, {"Key", pl::Value::String(key)}}));
    uint32_t length = htonl(static_cast<uint32_t>(xml.size()));
    socket.send_all(std::span(reinterpret_cast<const uint8_t*>(&length), 4));
    socket.send_all(std::span(reinterpret_cast<const uint8_t*>(xml.data()), xml.size()));
    auto header = socket.receive_exact(4);
    memcpy(&length, header.data(), 4); length = ntohl(length);
    if (length > 1024 * 1024) throw std::runtime_error("Invalid device response");
    auto body = socket.receive_exact(length);
    auto response = pl::parse_xml(std::string(body.begin(), body.end()));
    auto value = response.find("Value");
    return value ? value->string_or() : "";
}

static uint64_t timestamp(const cm::SampleBuffer& sample) {
    if (sample.output_presentation_timestamp) {
        auto n = sample.output_presentation_timestamp->to_100ns();
        if (n && *n >= 0) return static_cast<uint64_t>(*n / 10);
    }
    if (!sample.timing.empty()) {
        auto n = sample.timing.front().presentation_timestamp.to_100ns();
        if (n && *n >= 0) return static_cast<uint64_t>(*n / 10);
    }
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
}

static void video(const cm::SampleBuffer& sample, std::optional<cm::FormatDescription>& format) {
    static unsigned rotation = 0;
    if (auto turns = cm::display_rotation_turns(sample.display_rotation)) rotation = *turns;
    if (sample.format) format = sample.format;
    if (!format || !format->is_video()) return;
    if (format->video_codec() != cm::VideoCodec::H264) throw std::runtime_error("USB sender selected an unsupported video codec");
    std::vector<uint8_t> annex;
    auto append = [&](const std::vector<uint8_t>& nal) { annex.insert(annex.end(), {0,0,0,1}); annex.insert(annex.end(), nal.begin(), nal.end()); };
    for (const auto& nal : format->sequence_parameter_sets) append(nal);
    for (const auto& nal : format->picture_parameter_sets) append(nal);
    const auto frame = iPhoneMirror::h264::avcc_to_annex_b(sample.sample_data, format->nalu_length_size);
    annex.insert(annex.end(), frame.begin(), frame.end());
    if (!annex.empty() && !mirrorlab_send_media(1, rotation, timestamp(sample), annex.data(), static_cast<uint32_t>(annex.size()))) stopping = true;
}

static void audio(const cm::SampleBuffer& sample, std::optional<cm::FormatDescription>& format) {
    if (sample.format) format = sample.format;
    if (!format || !format->audio) return;
    const auto& asbd = *format->audio;
    const auto channels = asbd.channels_per_frame;
    const auto bits = asbd.bits_per_channel;
    if (asbd.format_id != qt::fourcc('l','p','c','m') || !channels || channels > 8 || (bits != 16 && bits != 32)) return;
    const auto& data = sample.sample_data;
    const unsigned width = bits / 8;
    if (data.size() % (width * channels)) return;
    std::vector<float> pcm(data.size() / width);
    const bool is_float = (asbd.format_flags & 1) != 0;
    const bool big_endian = (asbd.format_flags & 2) != 0;
    const bool planar = (asbd.format_flags & 32) != 0;
    const auto frames = pcm.size() / channels;
    for (size_t i = 0; i < pcm.size(); ++i) {
        const size_t source = planar ? (i % channels) * frames + i / channels : i;
        uint32_t raw = 0;
        for (unsigned b = 0; b < width; b++) raw |= uint32_t(data[source * width + b]) << (8 * (big_endian ? width - b - 1 : b));
        float value;
        if (bits == 32 && is_float) memcpy(&value, &raw, 4);
        else if (bits == 16) value = int16_t(raw) / 32768.0f;
        else value = int32_t(raw) / 2147483648.0f;
        pcm[i] = value;
    }
    mirrorlab_send_media(2, (channels << 24) | static_cast<uint32_t>(asbd.sample_rate), timestamp(sample), pcm.data(), static_cast<uint32_t>(pcm.size() * 4));
}

// Diagnostic replay uses real captured QuickTime packets through the same
// session, H.264 and PCM handling as cable capture, without opening USB.
static int replay(const std::string& directory) {
    auto read = [&](const char* name) {
        std::ifstream file(directory + "/" + name, std::ios::binary);
        if (!file) throw std::runtime_error("Missing replay fixture");
        return std::vector<uint8_t>(std::istreambuf_iterator<char>(file), {});
    };
    qt::SessionProtocol protocol;
    qt::StreamDecoder decoder;
    auto ping = decoder.push(qt::make_ping());
    auto event = protocol.process(ping.front());
    if (event.outbound.size() != 1 || event.outbound.front() != qt::make_ping()) throw std::runtime_error("PING reply failed");
    std::optional<cm::FormatDescription> vf, af;
    for (const char* name : {"cwpa-request1", "afmt-request", "cvrp-request", "clok-request", "time-request1", "skew-request", "og-request", "asyn-feed"}) {
        const auto bytes = read(name);
        for (size_t at = 0; at < bytes.size(); at += 137) {
            for (const auto& packet : decoder.push(std::span(bytes).subspan(at, (std::min)(size_t(137), bytes.size() - at)))) {
                event = protocol.process(packet);
                if (event.state == qt::SessionState::Error) throw std::runtime_error(event.warning);
                if (std::string(name) == "afmt-request" && (event.outbound.size() != 1 || event.outbound.front() != read("afmt-reply"))) throw std::runtime_error("Audio format reply differs from captured protocol");
                if (event.video_sample) video(*event.video_sample, vf);
            }
        }
    }
    event = protocol.process(qt::parse_payload(read("asyn-eat")));
    if (event.audio_sample) audio(*event.audio_sample, af);
    if (!vf || !af || protocol.video_frames() != 1 || protocol.audio_packets() != 1 || protocol.stop_messages().size() != 2) throw std::runtime_error("Incomplete QuickTime replay");
    puts("USB_REPLAY_OK"); return 0;
}

// Ask the phone to end the QuickTime session cleanly: send stop, answer its
// SYNC/stop and wait for both stream releases, then send the final HPD0.
static void stop_quicktime(tr::LibUsb0Connection& usb, qt::SessionProtocol& protocol, qt::StreamDecoder& decoder, bool handshake_started) {
    try { for (const auto& p : protocol.stop_messages()) usb.write(p, 500); } catch (...) { return; }
    std::vector<uint8_t> buffer(1024 * 1024);
    int releases = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(handshake_started ? 6 : 1);
    while (releases < 2 && std::chrono::steady_clock::now() < deadline) {
        size_t n = 0;
        try { n = usb.read(buffer, 250); } catch (...) { return; }
        for (const auto& packet : decoder.push(std::span(buffer.data(), n))) {
            try { for (const auto& r : protocol.process(packet).outbound) usb.write(r, 500); } catch (...) {}
            if (packet.kind == qt::PacketKind::Async && packet.subtype == qt::fourcc('r','e','l','s')) ++releases;
        }
    }
    if (releases >= 2) try { for (const auto& m : protocol.complete_stop_messages()) usb.write(m, 500); } catch (...) {}
}

static int list() {
    tr::UsbMuxClient mux(27015);
    auto devices = mux.list_devices();
    bool first = true;
    printf("[");
    for (const auto& d : devices) {
        if (d.connection_type != "USB") continue;
        std::string name = "iPhone", model, version;
        try { auto n = device_value(mux, d.device_id, "DeviceName"); if (!n.empty()) name = n; model = device_value(mux, d.device_id, "ProductType"); version = device_value(mux, d.device_id, "ProductVersion"); } catch (...) {}
        const auto driver = driver_state(d.serial);
        printf("%s{\"serial\":%s,\"name\":%s,\"model\":%s,\"osVersion\":%s,\"driver\":\"%s\",\"parentService\":%s}", first ? "" : ",",
            json_string(d.serial).c_str(), json_string(name).c_str(), json_string(model).c_str(), json_string(version).c_str(),
            driver_label(driver), json_string(driver.service).c_str());
        first = false;
    }
    puts("]"); return 0;
}

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IONBF, 0);
    SetConsoleCtrlHandler(on_ctrl, TRUE);
    if (argc == 3 && std::string(argv[1]) == "--replay") {
        try { return replay(argv[2]); }
        catch (const std::exception& e) { fprintf(stderr, "%s\n", e.what()); return 1; }
    }
    if (argc == 2 && std::string(argv[1]) == "--list") {
        try { return list(); }
        catch (const std::exception& e) { fprintf(stderr, "%s\n", e.what()); return 1; }
    }
    if (argc == 2 && std::string(argv[1]) == "--probe") {
        printf("{\"runtimeAvailable\":true,\"driverInstalled\":%s}\n", tr::libusb0_installed() ? "true" : "false");
        return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "--driver") {
        const auto d = driver_state(argv[2]);
        printf("{\"driver\":\"%s\",\"present\":%s,\"instanceId\":%s,\"parentService\":%s}\n", driver_label(d), d.present ? "true" : "false", json_string(d.instance_id).c_str(), json_string(d.service).c_str());
        return 0;
    }
    if ((argc != 3 && argc != 4) || std::string(argv[1]) != "--capture") return 2;
    const std::string serial = argv[2];
    const bool audio_enabled = argc == 3 || std::string(argv[3]) != "--no-audio";
    std::optional<tr::LibUsb0Connection> usb;
    tr::AppleUsbIdentity identity;
    qt::SessionProtocol protocol({.requested_width=1206, .requested_height=2622, .request_native_display_size=false, .target_fps=60, .demo_mode=false, .request_audio=audio_enabled, .advertise_hevc_444=false, .native_airplay=false});
    qt::StreamDecoder decoder;
    bool activated = false;
    bool handshake_started = false;
    int result = 0;
    // EOF/stop comes from the owning app; keep normal USB restoration in this process.
    std::thread([] { std::string line; while (std::getline(std::cin, line)) if (line == "stop") break; stopping = true; }).detach();
    try {
        const auto driver = driver_state(serial);
        if (!driver.present) throw std::runtime_error("The selected iPhone is not connected over USB. Unlock it, trust this PC and reconnect the cable.");
        if (!driver.filter || !tr::libusb0_installed()) throw std::runtime_error("USB capture driver is not set up for this iPhone. Choose Set up USB on its card.");
        if (!driver.attached) throw std::runtime_error("USB capture driver is installed but not loaded yet. Unplug the iPhone, plug it back in, then retry.");
        if (!tr::libusb0_available()) throw std::runtime_error("The USB capture driver library cannot be loaded. Run Set up USB again.");
        auto device = tr::find_libusb0_device(tr::AppleUsbIdentity{.serial = serial});
        if (!device) throw std::runtime_error("The USB capture driver cannot see this iPhone. Unplug it, plug it back in unlocked, then retry.");
        identity = tr::make_apple_usb_identity(*device);
        if (identity.serial.empty()) identity.serial = serial;
        if (!identity.expected_quicktime_configuration) throw std::runtime_error("Cannot determine the iPhone's USB capture configuration");
        printf("USB_DEVICE configs=%u active=%u expected=%u topology=%s\n", device->configuration_count, device->active_configuration, identity.expected_quicktime_configuration, identity.topology_id.c_str());
        if (!tr::is_libusb0_quicktime_configuration_active(*device)) {
            puts("USB_ACTIVATING");
            // A separate helper owns the handle across the phone's
            // re-enumeration into its QuickTime configuration.
            if (!tr::LibUsb0Connection::enable_quicktime_configuration(identity))
                throw std::runtime_error("The iPhone rejected the screen-capture request. Unlock it and retry.");
            activated = true;
        }
        std::thread([] { while (!stopping) std::this_thread::sleep_for(std::chrono::milliseconds(100)); stop_source.request_stop(); }).detach();
        usb.emplace(tr::LibUsb0Connection::open_quicktime(identity, {
            .allow_conventional_fallback = false,
            .allow_configuration_initialization = true,
            .wait_for_activated_descriptor = activated,
            .stop_token = stop_source.get_token(),
        }));
        if (!usb->active_topology_id().empty()) identity.topology_id = usb->active_topology_id();
        puts("USB_HANDSHAKING");
        handshake_started = true;
        std::vector<uint8_t> buffer(1024 * 1024);
        std::optional<cm::FormatDescription> vf, af;
        const auto opened = std::chrono::steady_clock::now();
        auto last = opened;
        bool ping_kicked = false, streaming = false;
        while (!stopping) {
            const auto n = usb->read(buffer, 250);
            const auto now = std::chrono::steady_clock::now();
            if (n) last = now;
            if (!n) {
                if (protocol.state() == qt::SessionState::WaitingForPing) {
                    // A freshly activated configuration can expose its bulk
                    // pipes before iOS starts the endpoint; one control kick
                    // and PING after the first quiet second starts it.
                    if (!ping_kicked && now - opened >= std::chrono::seconds(1)) {
                        ping_kicked = true;
                        try { if (activated) usb->recover_handshake(); usb->write(qt::make_ping(), 1000); }
                        catch (const std::exception& e) { fprintf(stderr, "USB handshake kick: %s\n", e.what()); }
                    }
                    if (now - opened >= std::chrono::seconds(8)) throw std::runtime_error("The iPhone opened screen capture but did not respond. Keep it unlocked and retry.");
                }
                if (now - last > std::chrono::seconds(15)) throw std::runtime_error("No USB media received for 15 seconds");
            }
            if (!streaming && protocol.state() != qt::SessionState::WaitingForPing && protocol.video_frames() == 0 && now - opened > std::chrono::seconds(20))
                throw std::runtime_error("Screen capture started but the iPhone sent no video. Unlock it and retry.");
            for (const auto& packet : decoder.push(std::span(buffer.data(), n))) {
                auto event = protocol.process(packet);
                if (event.state == qt::SessionState::Error) throw std::runtime_error(event.warning);
                for (const auto& response : event.outbound) usb->write(response, 1000);
                if (event.video_sample) { video(*event.video_sample, vf); if (!streaming) { streaming = true; puts("USB_STREAMING"); } }
                if (event.audio_sample) audio(*event.audio_sample, af);
            }
        }
    } catch (const std::exception& e) { fprintf(stderr, "%s\n", e.what()); result = 1; }
    if (usb) {
        stop_quicktime(*usb, protocol, decoder, handshake_started);
        // Close the claimed stream handle before any configuration request;
        // the Apple filter stack is unsafe when that handle disconnects itself.
        usb->close();
        usb.reset();
        activated = true;
    }
    if (activated) {
        // Closing usually returns the phone to its normal configuration; the
        // helper only sends the restore request if it is still in QuickTime mode.
        for (int attempt = 0; attempt < 2; attempt++) {
            std::this_thread::sleep_for(std::chrono::seconds(2));
            try { if (tr::LibUsb0Connection::disable_quicktime_configuration(identity)) break; }
            catch (const std::exception& e) { fprintf(stderr, "USB restore: %s\n", e.what()); }
        }
    }
    puts("USB_STOPPED");
    return result;
}
