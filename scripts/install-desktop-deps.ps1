# 安装桌面执行器的 OCR 可选依赖（RapidOCR + Windows OCR）
#
# 用法（普通 PowerShell 即可，不需要管理员）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-desktop-deps.ps1
#
# 说明：
# - 使用 DSH 自带 Python 3.12 的 pip，把依赖装进 desktop\.vendor；
# - RapidOCR 体积较大（onnxruntime/opencv/numpy/Pillow），下载约 100–300 MB；
# - 不装也可以启动执行器，但 OCR 核验会返回 OCR_UNAVAILABLE，不能真实发布/删除；
# - 不要装到系统 Python 3.11 的 site-packages。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = 'D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $python = $cmd.Source } else { throw '找不到 DSH Python 3.12' }
}
$vendor = Join-Path $root 'desktop\.vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Write-Host "Python: $python"
Write-Host "目标:   $vendor"
& $python -m pip install --disable-pip-version-check --no-input --target $vendor rapidocr_onnxruntime winsdk
if ($LASTEXITCODE -ne 0) { throw "pip 安装失败，退出码 $LASTEXITCODE" }
Write-Host 'OCR 依赖安装完成。现在可以用 Start-Moments-Client-Admin.cmd 启动 geometry 执行器。'
