// Build THIRD-PARTY-NOTICES.txt from the packages esbuild actually put in the
// runtime bundles.
//
// Those bundles are what we redistribute, so they are what carries licence
// obligations — Apache-2.0 §4(a) in particular requires handing recipients a
// copy of the licence. Deriving the list from the bundler's own metafile rather
// than from package.json means a new dependency cannot be shipped without its
// notice: anything reachable from the entry points shows up here, and a package
// whose licence text we cannot find is a hard error.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;
/** Canonical SPDX texts, for packages that ship none of their own. */
const FALLBACK_DIR = 'scripts/licenses';
/** Upstreams for packages published without `repository` or `homepage`. */
const REPOSITORY = { copc: 'https://github.com/connormanning/copc.js' };

/** Package directories reachable from an esbuild metafile. */
export function bundledPackages(metafiles) {
  const dirs = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (m) dirs.add(m[1]);
    }
  }
  return [...dirs].sort();
}

function licenseTexts(dir, license) {
  const own = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ source: `${dir}/${f}`, text: readFileSync(`${dir}/${f}`, 'utf8').trim() }));
  if (own.length) return own;

  // No licence file in the published package (laz-perf is one): fall back to the
  // canonical text for the identifier it declares.
  const path = `${FALLBACK_DIR}/${license}.txt`;
  try {
    return [
      {
        source: `${path} (canonical ${license} text; the package ships no licence file)`,
        text: readFileSync(path, 'utf8').trim(),
      },
    ];
  } catch {
    throw new Error(
      `No licence text for ${dir} (declared "${license}"). ` +
        `Add the canonical text at ${path}, or vendor the package's own file.`,
    );
  }
}

export function renderNotices(metafiles, self) {
  const sections = bundledPackages(metafiles).map((dir) => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
    const url = (REPOSITORY[pkg.name] || repo || pkg.homepage || '')
      .replace(/^git\+|^git:\/\//, '')
      .replace(/\.git$/, '');
    return {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? 'UNKNOWN',
      url,
      texts: licenseTexts(dir, pkg.license ?? 'UNKNOWN'),
    };
  });

  const rule = '='.repeat(78);
  const lines = [
    `${self.name} ${self.version} — third-party notices`,
    '',
    `${self.name} itself is licensed under ${self.license}.`,
    '',
    'The runtime assets it ships (pointstream3d-sw.js, pointstream3d-worker.js and',
    'laz-perf.wasm) bundle the packages listed below. Their licences follow in full.',
    '',
    'CesiumJS is a peer dependency and is never bundled; it carries its own licence,',
    'supplied with your copy of Cesium.',
    '',
    rule,
    'SUMMARY',
    rule,
    '',
    ...sections.map((s) => `  ${s.name}@${s.version} — ${s.license}${s.url ? ` — ${s.url}` : ''}`),
    '',
  ];

  for (const s of sections) {
    lines.push(rule, `${s.name} ${s.version} (${s.license})`, ...(s.url ? [s.url] : []), rule, '');
    for (const { source, text } of s.texts) {
      lines.push(`--- ${source.replace(/^.*node_modules\//, '')} ---`, '', text, '');
    }
  }

  return lines.join('\n');
}

export function writeNotices(outDir, metafiles, self) {
  const path = `${outDir}/THIRD-PARTY-NOTICES.txt`;
  writeFileSync(path, `${renderNotices(metafiles, self).trimEnd()}\n`);
  return path;
}
