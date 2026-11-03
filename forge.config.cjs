module.exports = {
  outDir: 'release',
  packagerConfig: {
    name: 'UnifiedProductivity',
    executableName: 'Unified Productivity',
    asar: true,
    appBundleId: 'com.unifiedproductivity.desktop',
    ignore: [
      /^\/(?:\.git|\.audit|\.smoke-appdata|\.package-app|docs|src|\.github|release|scripts|tsconfig\.json|electron\.vite\.config\.ts|forge\.config\.cjs)(?:\/|$)/,
      /^\/\.env(?:$|\.)/,
      /^\/.*\.log$/,
    ],
    extraResource: [],
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { authors: 'Unified Productivity', description: 'A local desktop workspace for databases, SSH, and file transfer.' } },
    { name: '@electron-forge/maker-wix', platforms: ['win32'], config: { name: 'Unified Productivity', manufacturer: 'Unified Productivity', exe: 'Unified Productivity.exe', language: 1033, upgradeCode: '072df083-5b0f-4d3d-99aa-874edf1be779', appUserModelId: 'com.squirrel.UnifiedProductivity.UnifiedProductivity' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
  ],
};
