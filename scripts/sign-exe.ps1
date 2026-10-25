param(
  [string]$Path = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release\DSH-Moments-Client-1.2.0-win64-exe\DSH-Moments-Client.exe'),
  [string]$Thumbprint = 'D54E26CAE38C7C302FE583A7C3360A93C5C1EA5B'
)
$ErrorActionPreference = 'Stop'
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint"
if (-not $certificate.HasPrivateKey) { throw 'Code signing private key is unavailable.' }
$result = Set-AuthenticodeSignature -LiteralPath $Path -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
if (-not $result.SignerCertificate -or $result.SignerCertificate.Thumbprint -ne $Thumbprint) { throw 'Signature was not written.' }
if (-not $result.TimeStamperCertificate) { throw 'Timestamp was not written.' }
$result | Select-Object Path,Status,StatusMessage,SignerCertificate,TimeStamperCertificate
