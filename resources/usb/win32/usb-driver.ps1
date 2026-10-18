# SPDX-License-Identifier: GPL-3.0-or-later
# Mirrorlab USB capture setup. Runs elevated. Adds (or with -Remove, removes)
# the signed libusb-win32 1.2.6.0 UpperFilter on exactly one connected iPhone's
# USB parent device, the same per-device filter iPhoneMirror's driver manager
# installs. Apple's USB driver and usbccgp stay in place; no driver is replaced.
param(
  [Parameter(Mandatory = $true)][string]$Serial,
  [Parameter(Mandatory = $true)][string]$Result,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
function Done([bool]$ok, [string]$message, [bool]$replug = $false) {
  [ordered]@{ ok = $ok; message = $message; replug = $replug } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Result -Encoding UTF8
  exit ([int](-not $ok))
}
# Pinned libusb-win32 1.2.6.0 payload (same hashes iPhoneMirror pins).
$hashes = @{
  'install-filter.exe' = 'DF2ABF387893332F28C4DF68B10A6B176DC9706142055DCCCCF447F5A9CEDE2D'
  'libusb0.sys'        = '8058F2AFE6EF96A7D2DED432997FD8655970C9EA75A938EE4557D6A2CB4CC989'
  'libusb0.dll'        = '4F18B5D2C28AA66B648C8683C6D09B52B92CBBEE85984BBEFAD5F38A64BC2A14'
  'libusb0_x86.dll'    = '00CACA07869B19D10B370552AC7CC2F6F2EE246FC15DB11650F6CD3F4EF9B666'
}
try {
  $root = $PSScriptRoot
  foreach ($name in $hashes.Keys) {
    $file = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $file)) { Done $false "USB driver file is missing: $name. Rebuild the USB runtime." }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $hashes[$name]) { Done $false "USB driver file failed verification: $name. Rebuild the USB runtime." }
  }
  $wanted = ($Serial -replace '[-\s]', '').ToUpperInvariant()
  if ($wanted -notmatch '^[0-9A-F]{16,48}$') { Done $false 'Invalid iPhone serial.' }
  $devices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -match '^USB\\VID_05AC&PID_[0-9A-F]{4}\\([^\\]+)$' -and $Matches[1].ToUpperInvariant() -eq $wanted })
  if ($devices.Count -eq 0) { Done $false 'The iPhone is not connected. Plug it in, unlock it, trust this PC and retry.' }
  if ($devices.Count -gt 1) { Done $false 'More than one USB device matches this iPhone. Reconnect it and retry.' }
  $id = $devices[0].InstanceId
  $service = (Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_Service).Data
  $key = "HKLM:\SYSTEM\CurrentControlSet\Enum\$id"
  $filters = @((Get-ItemProperty -LiteralPath $key -Name UpperFilters -ErrorAction SilentlyContinue).UpperFilters)
  $filter = Join-Path $root 'install-filter.exe'

  if ($Remove) {
    if ($filters -notcontains 'libusb0') { Done $true 'The USB capture driver is not installed on this iPhone.' }
    $out = & $filter u "-di=$id" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Done $false "Removing the USB capture filter failed ($LASTEXITCODE). $($out.Trim())" }
  } else {
    if ($service -ne 'usbccgp') { Done $false "This iPhone is bound to '$service' instead of Windows' USB composite driver. Reinstall Apple Devices (or iTunes) USB support, reconnect the iPhone and retry." }
    if ((Get-AuthenticodeSignature -LiteralPath (Join-Path $root 'libusb0.sys')).Status -ne 'Valid') { Done $false 'Windows does not trust the bundled USB capture driver signature.' }
    $system = [Environment]::SystemDirectory
    $deploy = @(
      @((Join-Path $root 'libusb0.sys'), (Join-Path $system 'drivers\libusb0.sys')),
      @((Join-Path $root 'libusb0.dll'), (Join-Path $system 'libusb0.dll'))
    )
    $wow = Join-Path $env:windir 'SysWOW64'
    if (Test-Path -LiteralPath $wow) { $deploy += ,@((Join-Path $root 'libusb0_x86.dll'), (Join-Path $wow 'libusb0.dll')) }
    foreach ($pair in $deploy) {
      $source, $target = $pair
      if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target).Hash -eq (Get-FileHash -LiteralPath $source).Hash) { continue }
        Copy-Item -LiteralPath $target -Destination "$target.mirrorlab-backup" -Force
      }
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
    if ($filters -notcontains 'libusb0') {
      $out = & $filter i "-di=$id" 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { Done $false "Installing the USB capture filter failed ($LASTEXITCODE). $($out.Trim())" }
      $filters = @((Get-ItemProperty -LiteralPath $key -Name UpperFilters -ErrorAction SilentlyContinue).UpperFilters)
      if ($filters -notcontains 'libusb0') { Done $false 'Windows did not record the USB capture filter for this iPhone.' }
    }
  }

  # Reload this one device so the change applies without unplugging.
  $restarted = $false
  try {
    $p = Start-Process -FilePath pnputil.exe -ArgumentList "/restart-device `"$id`"" -Wait -PassThru -WindowStyle Hidden
    $restarted = $p.ExitCode -eq 0
  } catch { }
  if ($restarted) { Start-Sleep -Seconds 3 }
  if ($Remove) { Done $true $(if ($restarted) { 'USB capture driver removed.' } else { 'USB capture driver removed. Unplug and reconnect the iPhone to finish.' }) (-not $restarted) }
  Done $true $(if ($restarted) { 'USB capture is set up. Unlock your iPhone and choose Mirror with USB.' } else { 'USB capture is set up. Unplug and reconnect your iPhone, then choose Mirror with USB.' }) (-not $restarted)
} catch {
  Done $false $_.Exception.Message
}
