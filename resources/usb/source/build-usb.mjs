// Build the independent GPL QuickTime USB host from pinned iPhoneMirror sources.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = path.resolve('work/iPhoneMirror');
const commit = '31acd8a78e7038d46c7e1a6ee987b9035cf36dde';
const msys = path.resolve(process.env.MIRRORLAB_MSYS || 'work/msys64');
const runtime = path.resolve('resources/usb/win32');
const legal = path.resolve('resources/usb/source');
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });
fs.mkdirSync(runtime, { recursive: true });
fs.mkdirSync(legal, { recursive: true });
if (!fs.existsSync(path.join(source, '.git'))) run('git', ['clone', 'https://github.com/RayrenSX/iPhoneMirror.git', source]);
run('git', ['-C', source, 'fetch', '--depth', '1', 'origin', commit]);
if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('USB upstream source has local changes');
run('git', ['-C', source, 'checkout', commit]);
// Capture uses the libusb-win32 (libusb0) per-device filter backend. UsbDk is
// not used: its pipe table only covers configuration 1, and the QuickTime
// endpoints live in the hidden configuration (5 on current iPhones).
const units = ['Protocol/Plist', 'Protocol/QuickTimePacket', 'Protocol/QuickTimeSession', 'Media/CoreMedia', 'Media/H264', 'Transport/QtUsbTransport', 'Transport/LibUsb0Transport', 'Transport/UsbMuxClient', 'Transport/Socket', 'Device/AppleUsbDiscovery', 'Logging'];
const cxx = 'g++ -std=c++20 -O2 -D_WIN32_WINNT=0x0A00 -DWIN32_LEAN_AND_MEAN -DNOMINMAX';
const command = [cxx, '-I native -I work/iPhoneMirror/src/Core/src -I work/iPhoneMirror/third_party/libusb/include -I work/iPhoneMirror/third_party/libusb-win32/include', 'native/iphone-usb.cpp', ...units.map((u) => `work/iPhoneMirror/src/Core/src/${u}.cpp`), 'work/iPhoneMirror/third_party/libusb/lib/x64/libusb-1.0.lib work/iPhoneMirror/third_party/libusb-win32/lib/x64/libusb0-dynamic.lib', '-lws2_32 -lsetupapi -lcfgmgr32 -ladvapi32 -lbcrypt -lshell32 -o work/iphone-usb.exe',
  // Upstream's configuration switcher owns the phone's handle while it
  // re-enumerates into QuickTime mode. LibUsb0Transport launches it by name.
  '&&', cxx, '-DUNICODE -D_UNICODE -municode -I work/iPhoneMirror/src/Core/src -I work/iPhoneMirror/third_party/libusb-win32/include work/iPhoneMirror/src/Core/tools/UsbConfigurationSwitch.cpp work/iPhoneMirror/src/Core/tools/UsbDeviceReconnect.cpp work/iPhoneMirror/third_party/libusb-win32/lib/x64/libusb0-dynamic.lib -lcfgmgr32 -lsetupapi -ladvapi32 -o work/iPhoneMirror.UsbConfigurationSwitch.exe'].join(' ');
run(path.join(msys, 'usr/bin/bash.exe'), ['-lc', command], { env: { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1' } });
for (const [from, to] of [
  ['work/iphone-usb.exe', 'iphone-usb.exe'],
  ['work/iPhoneMirror.UsbConfigurationSwitch.exe', 'iPhoneMirror.UsbConfigurationSwitch.exe'],
  // Signed libusb-win32 1.2.6.0 capture filter, installed per device by usb-driver.ps1.
  ...['libusb0.sys', 'install-filter.exe'].map((name) => [`work/iPhoneMirror/src/DriverInstaller/Assets/libusb-win32-1.2.6.0/amd64/${name}`, name]),
  ['work/iPhoneMirror/src/DriverInstaller/Assets/libusb-win32-1.2.6.0/x86/libusb0_x86.dll', 'libusb0_x86.dll'],
  ['work/iPhoneMirror/third_party/libusb/bin/x64/libusb-1.0.dll', 'libusb-1.0.dll'],
  ['work/iPhoneMirror/src/DriverInstaller/Assets/libusb-win32-1.2.6.0/amd64/libusb0.dll', 'libusb0.dll'],
  ...['libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll'].map((name) => [path.join(msys, 'ucrt64/bin', name), name]),
]) fs.copyFileSync(from, path.join(runtime, to));
run('git', ['-C', source, 'archive', '--format=tar.gz', `--output=${path.join(legal, 'iphonemirror-source.tar.gz')}`, commit]);
for (const name of ['iphone-usb.cpp', 'mirrorlab_bridge.h']) fs.copyFileSync(path.join('native', name), path.join(legal, name));
fs.copyFileSync(path.join(runtime, 'usb-driver.ps1'), path.join(legal, 'usb-driver.ps1'));
for (const name of ['QtUsbTransport.cpp', 'usbdk_identity.h', 'usb_errors.h']) fs.rmSync(path.join(legal, name), { force: true });
fs.rmSync(path.join(runtime, 'UsbDk_1.0.22_x64.msi'), { force: true });
fs.mkdirSync(path.join(legal, 'libusb-win32'), { recursive: true });
for (const name of ['README.txt', 'AUTHORS.txt', 'COPYING_LGPL.txt', 'COPYING_GPL.txt']) fs.copyFileSync(path.join(source, 'src/DriverInstaller/Assets/libusb-win32-1.2.6.0', name), path.join(legal, 'libusb-win32', name));
fs.copyFileSync('scripts/build-usb.mjs', path.join(legal, 'build-usb.mjs'));
fs.writeFileSync(path.join(legal, 'README.txt'), `Independent GPL-3.0-or-later USB host. iPhoneMirror source: https://github.com/RayrenSX/iPhoneMirror at ${commit}.\nUnmodified upstream source, including licenses, is in iphonemirror-source.tar.gz; all upstream units, including iPhoneMirror.UsbConfigurationSwitch.exe, are compiled unmodified. Build from the Mirrorlab project: npm run build:usb.\nCapture uses the libusb-win32 1.2.6.0 per-device UpperFilter (libusb0.sys, install-filter.exe, libusb0.dll; LGPL, from iPhoneMirror's DriverInstaller/Assets, source zip included there). It is installed for one iPhone only when the user chooses Set up USB, via usb-driver.ps1, which verifies the pinned hashes. Apple's USB driver and usbccgp are not replaced.\nCompiler runtime source recipes and licenses accompany resources/airplay/source.\n`);
console.log('USB host and libusb0 capture driver payload prepared.');
