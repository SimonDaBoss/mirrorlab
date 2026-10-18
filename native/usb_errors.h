// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <stdexcept>
#include <format>
#include <cstdint>
class MirrorlabUsbConfigurationError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};
inline void mirrorlab_require_usb_configuration(uint8_t first, uint8_t capture) {
    if (!first || !capture) throw std::runtime_error("Cannot determine the iPhone's USB capture configuration");
    if (first != capture)
        throw MirrorlabUsbConfigurationError(std::format("USB capture requires configuration {}, but the installed UsbDk driver exposes configuration {}. This driver cannot provide this iPhone's capture endpoints. Use AirPlay for now; another restart will not fix this limitation.", capture, first));
}
