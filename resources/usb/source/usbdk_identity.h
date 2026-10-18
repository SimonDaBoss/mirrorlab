// SPDX-License-Identifier: GPL-3.0-or-later
// Use UsbDk's read-only identity inventory rather than opening a phone to read
// its serial. Opening a UsbDk handle redirects/re-enumerates the USB device.
#pragma once
#include <windows.h>
#include <cfgmgr32.h>
#include <libusb.h>
#include <cstddef>
#include <string>
#include <stdexcept>
#include "Transport/QtUsbTransport.h"
#include "Transport/LibUsb0Readiness.h"
#include "Transport/AppleUsbIdentityCache.h"

// Public ABI: daynix/UsbDk UsbDk/UsbDkData.h, Apache-2.0, Red Hat 2013-2014.
struct MirrorlabUsbDkDeviceInfo {
    WCHAR device_id[MAX_DEVICE_ID_LEN];
    WCHAR instance_id[MAX_DEVICE_ID_LEN];
    ULONG64 filter_id, port, speed;
    libusb_device_descriptor descriptor;
};
static_assert(sizeof(libusb_device_descriptor) == 18);
static_assert(offsetof(MirrorlabUsbDkDeviceInfo, filter_id) == 800);
static_assert(sizeof(MirrorlabUsbDkDeviceInfo) == 848);

static iPhoneMirror::transport::AppleUsbIdentity mirrorlab_usbdk_identity(const std::string& serial) {
    using namespace iPhoneMirror::transport;
    wchar_t system[MAX_PATH]{};
    if (!GetSystemDirectoryW(system, MAX_PATH)) throw std::runtime_error("Cannot locate Windows USB runtime");
    HMODULE module = LoadLibraryExW((std::wstring(system) + L"\\UsbDkHelper.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) throw std::runtime_error("Cannot load the installed UsbDk helper");
    struct Guard { HMODULE value; ~Guard() { FreeLibrary(value); } } guard{module};
    using GetList = BOOL (*)(MirrorlabUsbDkDeviceInfo**, ULONG*);
    using Release = void (*)(MirrorlabUsbDkDeviceInfo*);
    const auto get_list = reinterpret_cast<GetList>(GetProcAddress(module, "UsbDk_GetDevicesList"));
    const auto release = reinterpret_cast<Release>(GetProcAddress(module, "UsbDk_ReleaseDevicesList"));
    if (!get_list || !release) throw std::runtime_error("The UsbDk identity API is unavailable");
    MirrorlabUsbDkDeviceInfo* list{}; ULONG count{};
    if (!get_list(&list, &count)) throw std::runtime_error("UsbDk could not list connected devices");
    struct ListGuard { Release release; MirrorlabUsbDkDeviceInfo* list; ~ListGuard() { release(list); } } list_guard{release, list};
    AppleUsbIdentity selected;
    for (ULONG i = 0; i < count; i++) {
        const auto& d = list[i];
        if (d.descriptor.idVendor != 0x05ac) continue;
        std::string candidate;
        for (size_t j = 0; j < MAX_DEVICE_ID_LEN && d.instance_id[j]; j++) candidate += static_cast<char>(d.instance_id[j]);
        if (!apple_usb_serial_equal(candidate, serial)) continue;
        if (!selected.serial.empty()) throw std::runtime_error("More than one USB device has the selected iPhone identity");
        // libusb's UsbDk backend maps FilterID to bus and Port to its sole
        // port number. These are a backend-specific physical-port identity.
        selected.serial = serial;
        selected.topology_id = std::to_string(static_cast<uint8_t>(d.filter_id)) + ":" + std::to_string(static_cast<uint8_t>(d.port));
        selected.original_product_id = d.descriptor.idProduct;
    }
    if (selected.serial.empty()) throw std::runtime_error(count ? "The selected iPhone is absent from UsbDk. Reconnect it and retry." : "Windows has not activated USB capture on its USB hubs yet. Restart Windows once after installing USB support.");
    return selected;
}

static uint8_t mirrorlab_first_usb_configuration(libusb_context* context, const iPhoneMirror::transport::AppleUsbIdentity& identity) {
    libusb_device** devices{};
    const auto count = libusb_get_device_list(context, &devices);
    if (count < 0) throw std::runtime_error("Cannot read USB capture descriptors");
    struct Guard { libusb_device** devices; ~Guard() { libusb_free_device_list(devices, 1); } } guard{devices};
    for (std::ptrdiff_t i = 0; i < count; i++) {
        const auto topology = std::to_string(libusb_get_bus_number(devices[i])) + ":" + std::to_string(libusb_get_port_number(devices[i]));
        if (topology != identity.topology_id) continue;
        libusb_config_descriptor* descriptor{};
        if (libusb_get_config_descriptor(devices[i], 0, &descriptor) != LIBUSB_SUCCESS) break;
        const auto configuration = descriptor->bConfigurationValue;
        libusb_free_config_descriptor(descriptor); return configuration;
    }
    throw std::runtime_error("Cannot read the selected iPhone's USB configuration");
}
