from pathlib import Path
from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH).parent
datas = [(str(root / 'client/web' / name), 'client/web') for name in ('index.html', 'app.js', 'styles.css')]
datas += [(str(root / 'desktop/ocr/win_helper.py'), 'desktop/ocr')]
binaries, hiddenimports = [], []
for package in ('rapidocr_onnxruntime', 'winsdk', 'pywinauto'):
    package_datas, package_bins, package_imports = collect_all(package)
    datas += package_datas
    binaries += package_bins
    hiddenimports += package_imports
hiddenimports += ['client.auto_configure', 'client.discovery']

a = Analysis([str(root / 'scripts/exe-entry.py')], pathex=[str(root)],
             binaries=binaries, datas=datas, hiddenimports=hiddenimports,
             excludes=['tkinter', 'matplotlib', 'pytest', 'IPython'])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='DSH-Moments-Client',
          console=False, uac_admin=True, upx=False, manifest=str(root / 'scripts/moments-client.manifest'))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='DSH-Moments-Client-1.2.0-win64-exe')
