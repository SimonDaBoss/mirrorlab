// Packages a portable app folder: out/Mirrorlab-<platform>-<arch>/Mirrorlab(.exe)
import { packager } from "@electron/packager";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? "x64";
if (!existsSync("dist/main/main.js")) throw new Error("Run `npm run build` first");

const extraResource = ["resources/scrcpy-server", "resources/SCRCPY-LICENSE.txt"];
if (existsSync(`resources/airplay/${platform}/uxplay${platform === "win32" ? ".exe" : ""}`)) extraResource.push("resources/airplay");
else throw new Error("Missing native AirPlay receiver. Run npm run build:airplay before packaging.");
if (platform === "win32") {
  extraResource.push("resources/adb");
  if (!existsSync("resources/usb/win32/iphone-usb.exe")) throw new Error("Missing USB host. Run npm run build:usb before packaging.");
  extraResource.push("resources/usb");
}

const paths = await packager({
  dir: ".",
  name: "Mirrorlab",
  platform,
  arch,
  out: "out",
  overwrite: true,
  asar: true,
  prune: true,
  extraResource,
  ignore: [/^\/src/, /^\/test/, /^\/out/, /^\/work/, /^\/scripts/, /^\/resources/, /\.gitbundle$/, /\.map$/, /^\/playwright\.config/, /^\/vitest\.config/, /^\/tsconfig/],
  appCopyright: "Mirrorlab contributors. Includes scrcpy (Apache-2.0, Genymobile) and Android adb (Apache-2.0, AOSP).",
});
console.log("packaged:", paths.join(", "));
// Old developer folders can still contain the retired UsbDk installer.
for (const folder of paths) rmSync(path.join(folder, "resources/usb/win32/UsbDk_1.0.22_x64.msi"), { force: true });
