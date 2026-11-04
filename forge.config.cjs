const path = require('node:path');
const appIcon = path.join(__dirname, 'assets', 'aetherexa.ico');
const appIconUrl = 'https://raw.githubusercontent.com/kawing11a/aetherexa/main/assets/aetherexa.ico';

module.exports = {
  outDir: 'release',
  packagerConfig: {
    name: 'Aetherexa',
    executableName: 'Aetherexa',
    asar: true,
    appBundleId: 'com.aetherexa.desktop',
    icon: appIcon,
    ignore: [
      /^\/(?:\.git|\.audit|\.smoke-appdata|\.package-app|assets|docs|src|\.github|release|scripts|tsconfig\.json|electron\.vite\.config\.ts|forge\.config\.cjs)(?:\/|$)/,
      /^\/\.env(?:$|\.)/,
      /^\/.*\.log$/,
    ],
    extraResource: [],
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { authors: 'Aetherexa', description: 'An open-source desktop workspace for databases, SSH, and file transfer.', iconUrl: appIconUrl, setupIcon: appIcon } },
    { name: '@electron-forge/maker-wix', platforms: ['win32'], config: { name: 'Aetherexa', manufacturer: 'Aetherexa', exe: 'Aetherexa.exe', icon: appIcon, language: 1033, upgradeCode: '072df083-5b0f-4d3d-99aa-874edf1be779', appUserModelId: 'com.squirrel.aetherexa.Aetherexa' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
  ],
};
