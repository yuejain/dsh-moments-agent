# Compatibility launcher: one elevated Python host owns client and executor.
param(
  [string]$ExpectedAccount = $env:DSH_MOMENTS_EXPECTED_ACCOUNT,
  [switch]$AllowPublish,
  [string]$ClientVersion = '4.1.10.27',
  [int]$ClientPort = 18770,
  [int]$ExecutorPort = 18765,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = 'D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  $python = (Get-Command python -ErrorAction Stop).Source
}
$clientArgs = @('-X', 'utf8', (Join-Path $root 'client\server.py'),
  '--port', $ClientPort, '--executor-port', $ExecutorPort,
  '--client-version', $ClientVersion)
if ($ExpectedAccount) { $clientArgs += @('--expected-account', $ExpectedAccount) }
if ($AllowPublish) { $clientArgs += '--allow-publish' }
if ($NoBrowser) { $clientArgs += '--no-browser' }
& $python @clientArgs
exit $LASTEXITCODE
