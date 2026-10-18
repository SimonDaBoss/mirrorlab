# Supported systems and troubleshooting

Mirrorlab currently ships for **Windows 10/11 x64**. It has been tested with an iPhone 16 Pro on iOS 27.0. Other iPhones, iPads, Windows installations and USB driver combinations need community testing; support for every device is not guaranteed.

## Portable download

Download the Windows ZIP from this repository's Releases page, extract the **entire folder**, and open `Mirrorlab.exe`. Keep its `resources` folder alongside it. Node.js and developer tools are not required for the portable app. The desktop app is not code-signed; use the release checksum to check the download. Do not disable Windows security protections to run a blocked app or driver.

## iPhone over AirPlay

Apple's Bonjour service must be installed and running. Apple provides [Bonjour Print Services for Windows](https://support.apple.com/en-us/106380). Use a trusted private network and allow Mirrorlab's native receiver through the firewall if prompted. The phone and PC must be on the same network; guest networks and client isolation may prevent discovery.

Open Control Center → Screen Mirroring → Mirrorlab. iPhone mirroring is view-only. Protected video apps may show a black picture. Actual frame rate depends on the sender, network and PC; 60 fps is a target, not a guarantee.

## iPhone over USB

Install [Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k) or iTunes to obtain Apple's Windows USB drivers. Use a data-capable cable, unlock the iPhone and accept Trust This Computer. Choose **Set up USB** on its card, approve the administrator prompt, and reconnect if requested. Then choose **Mirror with USB**.

USB setup adds the bundled, hash-checked libusb-win32 filter to the selected iPhone only. USB filter compatibility varies across Apple driver versions and Windows installations. If Windows blocks the driver, use AirPlay; do not disable Memory Integrity or driver-signature enforcement. Setup is optional and is never run merely by opening the app.

To remove the filter, open administrator PowerShell in the extracted app folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File resources/usb/win32/usb-driver.ps1 -Serial <YOUR-IPHONE-UDID> -Result "$env:TEMP/mirrorlab-usb-remove.json" -Remove
```

Reconnect the phone afterward. The USB diagnostic log is `%TEMP%/mirrorlab-usb.log`. Before attaching logs to a public issue, remove device serial numbers, phone names, local paths and other private details.

## Android

Enable USB debugging, accept the phone's debugging prompt, and choose Mirror. Windows may also need the phone manufacturer's USB driver. Wireless debugging requires Android 11 or newer. Phone audio capture requires Android 11 or newer.

## Reporting problems

Open a GitHub issue with your Windows version, phone model, OS version, connection method and steps to reproduce. Never include pairing records, private keys, authentication tokens or an unredacted screen recording. The optional local AI-agent endpoint uses a generated bearer token; keep that token private.
