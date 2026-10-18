param([string]$MsysRoot = "$PSScriptRoot\..\work\msys64")
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath("$PSScriptRoot\..")
Set-Location -LiteralPath $root
$MsysRoot = [IO.Path]::GetFullPath($MsysRoot)
New-Item -ItemType Directory -Force work | Out-Null
if (!(Test-Path -LiteralPath "$MsysRoot\usr\bin\bash.exe")) {
    # Portable build tools stay inside work/, with no machine-wide installation.
    $release = Invoke-RestMethod https://api.github.com/repos/msys2/msys2-installer/releases/latest
    $asset = $release.assets | Where-Object name -EQ 'msys2-base-x86_64-latest.tar.xz'
    if (!$asset) { throw 'MSYS2 portable archive is unavailable' }
    Invoke-WebRequest $asset.browser_download_url -OutFile work/msys2.tar.xz
    & tar -xf work/msys2.tar.xz -C work
    if ($LASTEXITCODE) { throw 'Could not extract MSYS2' }
    $MsysRoot = "$root\work\msys64"
}
$env:MSYSTEM = 'UCRT64'
$env:CHERE_INVOKING = '1'
$env:MIRRORLAB_MSYS = $MsysRoot
if (!(Test-Path -LiteralPath "$MsysRoot\ucrt64\bin\gcc.exe")) {
    & "$MsysRoot\usr\bin\bash.exe" -lc 'pacman -Syu --noconfirm'
    # A runtime update closes the first terminal; complete remaining upgrades in a fresh one.
    & "$MsysRoot\usr\bin\bash.exe" -lc 'pacman -Syu --noconfirm && pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-tools mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-openssl mingw-w64-ucrt-x86_64-libplist mingw-w64-ucrt-x86_64-gstreamer mingw-w64-ucrt-x86_64-gst-plugins-base mingw-w64-ucrt-x86_64-gst-plugins-good mingw-w64-ucrt-x86_64-gst-plugins-bad mingw-w64-ucrt-x86_64-gst-libav'
    if ($LASTEXITCODE) { throw 'Could not install native build dependencies' }
}
& node scripts/prepare-airplay.mjs
if ($LASTEXITCODE) { throw 'AirPlay preparation failed' }
