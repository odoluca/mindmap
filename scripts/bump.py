"""Set the app version everywhere it lives and stamp module imports for cache busting.

Usage: python scripts/bump.py 0.2.0
Updates src/version.js, version.json, package.json, the ?v= query on every relative
import inside src/, and the script tag in index.html.
"""
import os, re, sys, json

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if len(sys.argv) != 2 or not re.fullmatch(r'\d+\.\d+\.\d+', sys.argv[1]):
    sys.exit('usage: bump.py MAJOR.MINOR.PATCH')
v = sys.argv[1]

def rewrite(path, fn):
    with open(path, encoding='utf-8') as f:
        s = f.read()
    t = fn(s)
    if t != s:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(t)
    return t != s

rewrite(os.path.join(root, 'src', 'version.js'), lambda s: f"export const APP_VERSION = '{v}';\n")
rewrite(os.path.join(root, 'version.json'), lambda s: json.dumps({'version': v}) + '\n')
rewrite(os.path.join(root, 'package.json'), lambda s: re.sub(r'"version": "[^"]+"', f'"version": "{v}"', s, count=1))
imp = re.compile(r"""(from\s+['"]\./[\w\-]+\.js)(\?v=[^'"]*)?(['"])""")
dyn = re.compile(r"""(import\(['"]\./[\w\-]+\.js)(\?v=[^'"]*)?(['"]\))""")
changed = 0
for name in sorted(os.listdir(os.path.join(root, 'src'))):
    if name.endswith('.js'):
        p = os.path.join(root, 'src', name)
        changed += rewrite(p, lambda s: dyn.sub(lambda m: f"{m.group(1)}?v={v}{m.group(3)}", imp.sub(lambda m: f"{m.group(1)}?v={v}{m.group(3)}", s)))
rewrite(os.path.join(root, 'index.html'), lambda s: re.sub(r'src="src/main\.js(\?v=[^"]*)?"', f'src="src/main.js?v={v}"', s))
print(f'version {v}: stamped {changed} source files')
