# Third-party software and source

Mirrorlab's TypeScript application is Apache-2.0. Its independent native helper programs are GPL-3.0-or-later and communicate through localhost media streams. Dependencies retain their own licenses. See `NOTICE` and the license texts in `resources`.

The downloadable portable folder includes these source materials alongside the native executables:

- `resources/airplay/source/uxplay-source.tar.gz`: UxPlay at commit `df67c212a433cf6dda3676dd40c097900d24e645`; apply `mirrorlab.patch` and add `mirrorlab_bridge.h`. Rebuild with `npm run build:airplay` from this repository.
- `resources/usb/source/iphonemirror-source.tar.gz`: iPhoneMirror at commit `31acd8a78e7038d46c7e1a6ee987b9035cf36dde`, including protocol, transport, configuration switcher and driver source materials. Mirrorlab's native host and build script accompany it. Rebuild with `npm run build:usb` after preparing the native toolchain.
- `resources/airplay/source/msys2-packages.txt`: exact dependency versions used for the Windows receiver. License texts are in the adjacent `licenses` folder. Corresponding MSYS2 package source archives are available from [the MSYS2 source archive server](https://repo.msys2.org/mingw/sources/), with build recipes and upstream source/checksum references in [MINGW-packages](https://github.com/msys2/MINGW-packages).
- Bonjour client distribution and its pinned download checksum are recorded in `resources/airplay/source/README.txt`. Apple's [mDNSResponder source](https://github.com/apple-oss-distributions/mDNSResponder) contains the Bonjour client implementation.
- Android adb and scrcpy notices and pinned release hashes are in `NOTICE`; the scrcpy license is in `resources/SCRCPY-LICENSE.txt`.

No proprietary ApowerMirror DLLs, decompiled assemblies, pairing keys, user data or diagnostic captures are included in the repository or portable download.
