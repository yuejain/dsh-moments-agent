# Build a single-process Windows application (onedir avoids a onefile extractor process).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and can
# mis-parse non-ASCII comments. Chinese docs live in docs/EXE-RELEASE.md instead.
param([string]$SigningThumbprint)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.tmp\exe-build-env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Create .tmp/exe-build-env and install scripts/exe-requirements.txt first.' }
& $python -m PyInstaller --noconfirm --distpath (Join-Path $root 'release') --workpath (Join-Path $root '.tmp\exe-build') (Join-Path $PSScriptRoot 'moments-client.spec')
if ($LASTEXITCODE -ne 0) { throw 'EXE build failed.' }
$destination = Join-Path $root 'release\DSH-Moments-Client-1.2.3-win64-exe'
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $destination -Force
New-Item -ItemType Directory -Path (Join-Path $destination 'client') -Force | Out-Null
# Relative paths are resolved against the EXE directory when frozen. The first-run
# auto-configuration rewrites them to the detected plugin data directory.
$clientConfigPath = Join-Path $destination 'client\moments-client.json'
$clientConfigJson = '{"version":1,"baseUrl":"http://127.0.0.1:18766","tokenFile":"data/admin-token.txt","dataDir":"data"}'
if (-not $clientConfigPath) { throw 'Failed to resolve client config path.' }
[IO.File]::WriteAllText($clientConfigPath, $clientConfigJson, (New-Object System.Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath $clientConfigPath)) { throw 'Failed to write client/moments-client.json.' }
Copy-Item -LiteralPath (Join-Path $root 'docs\EXE-RELEASE.md') -Destination (Join-Path $destination 'README-WINDOWS.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'docs\QUIET_AUTONOMOUS_PUBLISHING.md') -Destination $destination -Force
& $python (Join-Path $PSScriptRoot 'exe-notices.py') (Join-Path $destination 'third-party-licenses')
if ($LASTEXITCODE -ne 0) { throw 'License collection failed.' }
if ($SigningThumbprint) {
  & (Join-Path $PSScriptRoot 'sign-exe.ps1') -Path (Join-Path $destination 'DSH-Moments-Client.exe') -Thumbprint $SigningThumbprint
  Export-Certificate -Cert (Get-Item -LiteralPath "Cert:\CurrentUser\My\$SigningThumbprint") -FilePath (Join-Path $destination 'Local-Signer.cer') | Out-Null
}
$archive = "$destination.zip"
Compress-Archive -LiteralPath $destination -DestinationPath $archive -Force
Get-FileHash -LiteralPath (Join-Path $destination 'DSH-Moments-Client.exe'), $archive -Algorithm SHA256 | Format-Table -AutoSize
