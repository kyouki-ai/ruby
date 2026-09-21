// electron-builder's `--dir` target never runs rcedit (that only happens on
// a full build with signAndEditExecutable enabled, which is disabled here -
// see package.json's build.win.signAndEditExecutable comment), so the
// packaged Ruby.exe keeps Electron's own default icon unless something else
// stamps ours on. rcedit itself is already sitting in electron-builder's own
// tool cache (it ships one for its own signing step), so this just reuses
// that copy instead of pulling in a new dependency.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'Ruby.exe');
const iconPath = path.join(__dirname, '..', 'assets', 'icon-ruby-v3.ico');

function findRcedit() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;
  const versionDirs = fs.readdirSync(cacheRoot).sort().reverse();
  for (const dir of versionDirs) {
    const candidate = path.join(cacheRoot, dir, 'rcedit-x64.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

if (!fs.existsSync(exePath)) {
  console.warn('set-exe-icon: no packaged exe found at', exePath, '- skipping');
  process.exit(0);
}

const rcedit = findRcedit();
if (!rcedit) {
  console.warn('set-exe-icon: rcedit not found in electron-builder cache - packaged exe keeps the default icon');
  process.exit(0);
}

execFileSync(rcedit, [exePath, '--set-icon', iconPath], { stdio: 'inherit' });
console.log('set-exe-icon: applied', iconPath, 'to', exePath);
