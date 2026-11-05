const { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const output = path.resolve(process.argv[2] ?? path.join(root, 'release', 'THIRD-PARTY-NOTICES.md'));
const sbomPath = path.resolve(process.argv[3] ?? path.join(root, 'release', 'aetherexa-sbom.spdx.json'));
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
const packages = new Map();

for (const item of sbom.packages) {
  const location = item.packageFileName;
  if (!location?.startsWith('node_modules/')) continue;
  const packageRoot = path.join(root, location);
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = manifest.name ?? item.name;
  const version = manifest.version ?? item.versionInfo ?? 'unknown';
  const id = `${name}@${version}`;
  if (packages.has(id)) continue;
  const license = typeof manifest.license === 'string'
    ? manifest.license
    : Array.isArray(manifest.licenses)
      ? manifest.licenses.map((item) => item.type ?? 'unknown').join(' OR ')
      : 'Not declared';
  const notices = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(license|licence|copying|notice)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, text: readFileSync(path.join(packageRoot, entry.name), 'utf8').trim() }))
    .filter((entry) => entry.text);
  packages.set(id, { name, version, license, notices });
}

const sections = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)).map((item) => {
  const heading = `## ${item.name}@${item.version}`;
  const license = `License: ${item.license}`;
  const notices = item.notices.length
    ? item.notices.map((notice) => `### ${notice.name}\n\n${notice.text}`).join('\n\n')
    : 'No license or notice text file is bundled with this package.';
  return `${heading}\n\n${license}\n\n${notices}`;
});

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `# Third-party notices for Aetherexa ${lock.version}\n\n${sections.join('\n\n---\n\n')}\n`, 'utf8');
process.stdout.write(`Wrote notices for ${packages.size} SBOM dependencies to ${output}\n`);
