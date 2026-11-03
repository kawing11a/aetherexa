module.exports = {
  outDir: 'release',
  packagerConfig: {
    name: 'UnifiedProductivity',
    executableName: 'Unified Productivity',
    asar: true,
    appBundleId: 'com.unifiedproductivity.desktop',
    ignore: [
      /^\/(?:\.git|\.audit|\.smoke-appdata|\.package-app|docs|src|\.github|release|tsconfig\.json|electron\.vite\.config\.ts|forge\.config\.cjs)(?:\/|$)/,
      /^\/\.env(?:$|\.)/,
      /^\/.*\.log$/,
    ],
    extraResource: [],
  },
  rebuildConfig: {},
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['win32'] }],
};
