"""Collect installed wheel license texts for the portable distribution."""
import importlib.metadata
import json
import sys
from pathlib import Path

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
packages = []
for distribution in importlib.metadata.distributions():
    name = distribution.metadata['Name']
    packages.append({'name': name, 'version': distribution.version,
                     'license': distribution.metadata.get('License-Expression') or distribution.metadata.get('License', '')})
    for file in distribution.files or []:
        if any(part.lower().startswith(('license', 'copying', 'notice')) for part in file.parts):
            source = Path(distribution.locate_file(file))
            if source.is_file():
                target = destination / name / Path(*file.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
(destination / 'packages.json').write_text(json.dumps(packages, ensure_ascii=False, indent=2), encoding='utf-8')
