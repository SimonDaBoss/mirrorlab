// Rebuild a pinned, independently runnable UxPlay receiver and collect only its runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const msys = path.resolve(process.env.MIRRORLAB_MSYS || 'work/msys64');
const bin = path.join(msys, 'ucrt64/bin');
const source = path.resolve('work/UxPlay');
const runtime = path.resolve('resources/airplay/win32');
const sdk = path.resolve('work/bonjour-sdk');
const commit = 'df67c212a433cf6dda3676dd40c097900d24e645'; // UxPlay v1.73.7
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function imports(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c), count = b.readUInt16LE(pe + 6), optionalSize = b.readUInt16LE(pe + 20), optional = pe + 24;
  const directory = optional + (b.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const offset = (rva) => {
    for (let i = 0; i < count; i++) {
      const s = optional + optionalSize + i * 40, start = b.readUInt32LE(s + 12);
      if (rva >= start && rva < start + Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16))) return b.readUInt32LE(s + 20) + rva - start;
    }
    throw new Error(`Bad PE import address: ${file}`);
  };
  const table = b.readUInt32LE(directory + 8);
  if (!table) return [];
  let at = offset(table);
  const names = [];
  while (b.readUInt32LE(at + 12)) {
    const str = offset(b.readUInt32LE(at + 12));
    names.push(b.subarray(str, b.indexOf(0, str)).toString('ascii'));
    at += 20;
  }
  return names;
}
async function download(url, file, hash) {
  if (!fs.existsSync(file)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  if (hash && digest(file) !== hash) throw new Error(`Checksum mismatch: ${file}`);
}
fs.mkdirSync('work', { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
if (!fs.existsSync(path.join(source, '.git'))) run('git', ['clone', 'https://github.com/FDH2/UxPlay.git', source]);
run('git', ['-C', source, 'fetch', '--depth', '1', 'origin', commit]);
// Refuse to discard unrelated edits in a developer's copy of the native sources.
const status = execFileSync('git', ['-C', source, 'diff', '--name-only'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
if (status.some((f) => !['uxplay.cpp', 'lib/fairplay_playfair.c'].includes(f))) throw new Error('Native sources contain unrelated local changes');
run('git', ['-C', source, 'checkout', commit]);
const mainFile = path.join(source, 'uxplay.cpp');
let main = fs.readFileSync(mainFile, 'utf8');
if (!main.includes('MIRRORLAB_DISCONNECTED')) {
  main = main.replace('    std::vector<char> server_hw_addr;', '    setvbuf(stdout, NULL, _IONBF, 0); // Mirrorlab: immediate process events\n    std::vector<char> server_hw_addr;');
  main = main.replace('    if (open_connections == 0) {', '    if (open_connections == 0) {\n        printf("MIRRORLAB_DISCONNECTED\\n");');
  fs.writeFileSync(mainFile, main);
}
fs.copyFileSync('native/mirrorlab_bridge.h', path.join(source, 'mirrorlab_bridge.h'));
if (!main.includes('#include "mirrorlab_bridge.h"')) {
  main = main.replace('#include "lib/raop.h"', '#include "mirrorlab_bridge.h"\n#include "lib/raop.h"');
  main = main.replace('extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {', 'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {\n    if (mirrorlab_bridge_enabled()) {\n        mirrorlab_send_media(1, 0, data->ntp_time_remote / 1000, data->data, data->data_len);\n        return;\n    }');
  fs.writeFileSync(mainFile, main);
}
const fairplayFile = path.join(source, 'lib/fairplay_playfair.c');
let fairplay = fs.readFileSync(fairplayFile, 'utf8');
if (!fairplay.includes('mode > 3')) fairplay = fairplay.replace('    int mode = req[14];', '    int mode = req[14];\n    if (mode < 0 || mode > 3) return -1;');
fs.writeFileSync(fairplayFile, fairplay);

// The open-source Windows runtime supplies the 64-bit Bonjour client DLL. Reuse the existing Bonjour service.
const zip = path.resolve('work/uxplay-windows.zip');
const zipUrl = 'https://github.com/leapbtw/uxplay-windows/releases/download/2.0.0.1736/uxplay-windows.zip';
await download(zipUrl, zip, '9d3a51c15fc9db857351195e7eb7bbb21700d9ae25d936a54bcf8536b62cca18');
for (const d of ['Bin/x64', 'Lib/x64', 'Include']) fs.mkdirSync(path.join(sdk, d), { recursive: true });
run('tar', ['-xf', zip, '-C', path.join(sdk, 'Bin/x64'), 'dnssd.dll']);
// Header is bundled with corresponding native source, so subsequent offline rebuilds are possible.
await download('https://raw.githubusercontent.com/apple-oss-distributions/mDNSResponder/main/mDNSShared/dns_sd.h', path.join(sdk, 'Include/dns_sd.h'));
const env = { ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1', BONJOUR_SDK_HOME: sdk.replaceAll('\\', '/') };
run(path.join(bin, 'gendef.exe'), [path.join(sdk, 'Bin/x64/dnssd.dll')], { cwd: path.join(sdk, 'Lib/x64'), env });
run(path.join(bin, 'dlltool.exe'), ['-d', 'dnssd.def', '-l', 'dnssd.lib'], { cwd: path.join(sdk, 'Lib/x64'), env });
run(path.join(msys, 'usr/bin/bash.exe'), ['-lc', 'cmake -S work/UxPlay -B work/uxplay-build -G Ninja -DNO_MARCH_NATIVE=ON -DCMAKE_BUILD_TYPE=Release && cmake --build work/uxplay-build -j 8'], { env });

const seeds = [
  [path.resolve('work/uxplay-build/uxplay.exe'), 'uxplay.exe'],
  [path.join(sdk, 'Bin/x64/dnssd.dll'), 'dnssd.dll'],
  [path.join(bin, 'gst-launch-1.0.exe'), 'gst-launch-1.0.exe'],
  [path.join(bin, 'gst-inspect-1.0.exe'), 'gst-inspect-1.0.exe'],
];
const plugins = ['app', 'coreelements', 'playback', 'autodetect', 'typefindfunctions', 'videoparsersbad', 'rtp', 'udp', 'audioconvert', 'audioresample', 'volume', 'libav', 'fdkaac', 'videoconvertscale', 'jpeg', 'imagefreeze', 'pango', 'audiotestsrc'];
for (const p of plugins) seeds.push([path.join(msys, `ucrt64/lib/gstreamer-1.0/libgst${p}.dll`), `lib/gstreamer-1.0/libgst${p}.dll`]);
const done = new Set();
for (let i = 0; i < seeds.length; i++) {
  const [file, relative] = seeds[i];
  if (done.has(relative.toLowerCase())) continue;
  done.add(relative.toLowerCase());
  const target = path.join(runtime, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  for (const name of imports(file)) {
    const dep = path.join(bin, name);
    if (fs.existsSync(dep)) seeds.push([dep, name]);
  }
}
// Full source + local patch, licenses and installed dependency versions accompany the independent receiver.
const legal = path.resolve('resources/airplay/source');
fs.mkdirSync(legal, { recursive: true });
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(legal, 'UXPLAY-GPL-3.0.txt'));
fs.copyFileSync(path.join(source, 'lib/playfair/LICENSE.md'), path.join(legal, 'PLAYFAIR-LICENSE.txt'));
fs.copyFileSync('native/mirrorlab_bridge.h', path.join(legal, 'mirrorlab_bridge.h'));
fs.writeFileSync(path.join(legal, 'mirrorlab.patch'), execFileSync('git', ['-C', source, 'diff'], { encoding: 'utf8' }));
run('git', ['-C', source, 'archive', '--format=tar.gz', `--output=${path.join(legal, 'uxplay-source.tar.gz')}`, commit]);
fs.copyFileSync(path.join(sdk, 'Include/dns_sd.h'), path.join(legal, 'dns_sd.h'));
fs.cpSync(path.join(msys, 'ucrt64/share/licenses'), path.join(legal, 'licenses'), { recursive: true });
const versions = execFileSync(path.join(msys, 'usr/bin/bash.exe'), ['-lc', 'pacman -Q'], { encoding: 'utf8', env });
fs.writeFileSync(path.join(legal, 'msys2-packages.txt'), versions);
fs.writeFileSync(path.join(legal, 'README.txt'), `UxPlay ${commit} (v1.73.7), https://github.com/FDH2/UxPlay\nApply mirrorlab.patch to uxplay-source.tar.gz. Build: npm run build:airplay.\nThe receiver is a separate GPL-3.0-or-later program; Mirrorlab communicates via framed localhost TCP video and RTP audio.\nWindows Bonjour client: ${zipUrl}\nArchive SHA-256: ${digest(zip)}\nSources and build scripts: https://github.com/leapbtw/uxplay-windows/tree/2.0.0.1736\nApple mDNSResponder sources: https://github.com/apple-oss-distributions/mDNSResponder\nRuntime dependencies are unmodified MSYS2 UCRT64 packages listed in msys2-packages.txt.\nCorresponding package source recipes: https://github.com/msys2/MINGW-packages\nSource archives: https://repo.msys2.org/mingw/sources/\nEach package recipe identifies upstream source URLs and checksums. Licenses are in licenses/.\n`);
fs.writeFileSync(path.join(runtime, 'manifest.json'), JSON.stringify({ uxplay: commit, files: [...done].sort(), builtAt: new Date().toISOString() }, null, 2));
console.log(`Bundled UxPlay and ${done.size} runtime files in ${runtime}`);
