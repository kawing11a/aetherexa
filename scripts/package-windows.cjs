const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const localAppData = process.env.LOCALAPPDATA || '';
const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const wixHome = process.env.WIX3_HOME;
const candidates = [
  wixHome,
  wixHome && path.join(wixHome, 'bin'),
  path.join(programFiles, 'WiX Toolset v3.14', 'bin'),
  path.join(programFilesX86, 'WiX Toolset v3.14', 'bin'),
  path.join(localAppData, 'Aetherexa', 'build-tools', 'wix3141', 'bin'),
  path.join(localAppData, 'Aetherexa', 'build-tools', 'wix3141'),
  path.join(localAppData, 'UnifiedProductivity', 'build-tools', 'wix3141', 'bin'),
  path.join(localAppData, 'UnifiedProductivity', 'build-tools', 'wix3141'),
].filter(Boolean);
const wixBin = candidates.find((directory) => existsSync(path.join(directory, 'candle.exe')) && existsSync(path.join(directory, 'light.exe')));

if (!wixBin) {
  console.error('WiX Toolset v3.14.1 is required to create the MSI. Install it or set WIX3_HOME to its folder. See docs/package-contents.md.');
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, '..');
const forgeCli = path.join(projectRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
if (!existsSync(forgeCli)) {
  console.error('Electron Forge is not installed. Run npm install before packaging.');
  process.exit(1);
}

const env = { ...process.env, PATH: `${wixBin}${path.delimiter}${process.env.PATH || ''}` };
const result = spawnSync(process.execPath, [forgeCli, 'make', '--platform', 'win32', '--arch', 'x64'], { cwd: projectRoot, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
