import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
};

const basePath = getArg('--base');
const prPath = getArg('--pr');
const outPath = getArg('--out');

if (!basePath || !prPath) {
  console.error('Usage: node scripts/validate-marketplace-pr.mjs --base <path> --pr <path> [--out <path>]');
  process.exit(2);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidId(value) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function isValidPath(value) {
  return isNonEmptyString(value) && value.startsWith('dist/');
}

function isValidSha256(value) {
  return /^[a-f0-9]{64}$/.test(value);
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableObject(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableObject(value));
}

async function readJson(path) {
  const text = await fs.readFile(path, 'utf8');
  return JSON.parse(text);
}

const errors = [];

const baseIndex = await readJson(basePath);
const prIndex = await readJson(prPath);

function validateIndexShape(index, label) {
  if (index.schemaVersion !== 1) {
    errors.push(`${label}: schemaVersion must be 1`);
  }
  if (!isNonEmptyString(index.name)) {
    errors.push(`${label}: name is required`);
  }
  if (!Array.isArray(index.plugins)) {
    errors.push(`${label}: plugins must be an array`);
    return [];
  }
  return index.plugins;
}

const basePlugins = validateIndexShape(baseIndex, 'base index.json');
const prPlugins = validateIndexShape(prIndex, 'pr index.json');

if (baseIndex.name !== prIndex.name) {
  errors.push('pr index.json: top-level name cannot be changed');
}

const basePluginMap = new Map();
for (const plugin of basePlugins) {
  if (plugin && isNonEmptyString(plugin.id)) {
    basePluginMap.set(plugin.id, plugin);
  }
}

const prPluginMap = new Map();
const prPluginIds = new Set();

for (const plugin of prPlugins) {
  if (!plugin || typeof plugin !== 'object') {
    errors.push('pr index.json: plugin entry must be an object');
    continue;
  }
  if (!isNonEmptyString(plugin.id) || !isValidId(plugin.id)) {
    errors.push('pr index.json: plugin id must match [a-zA-Z0-9_-]{1,64}');
  } else if (prPluginIds.has(plugin.id)) {
    errors.push(`pr index.json: duplicate plugin id "${plugin.id}"`);
  } else {
    prPluginIds.add(plugin.id);
  }
  if (!isNonEmptyString(plugin.name)) {
    errors.push(`pr index.json: plugin "${plugin.id || 'unknown'}" missing name`);
  }
  if (plugin.description !== undefined && !isNonEmptyString(plugin.description)) {
    errors.push(`pr index.json: plugin "${plugin.id || 'unknown'}" description must be non-empty`);
  }
  if (plugin.readme !== undefined) {
    try {
      const readmeUrl = new URL(String(plugin.readme || '').trim());
      if (readmeUrl.protocol !== 'https:') {
        errors.push(`pr index.json: plugin "${plugin.id || 'unknown'}" readme must use https`);
      }
    } catch {
      errors.push(`pr index.json: plugin "${plugin.id || 'unknown'}" readme must be a valid url`);
    }
  }
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    errors.push(`pr index.json: plugin "${plugin.id || 'unknown'}" must have versions`);
  }
  prPluginMap.set(plugin.id, plugin);
}

for (const [id, basePlugin] of basePluginMap.entries()) {
  const prPlugin = prPluginMap.get(id);
  if (!prPlugin) {
    errors.push(`pr index.json: plugin "${id}" removed`);
    continue;
  }
}

const downloads = [];

for (const plugin of prPlugins) {
  if (!plugin || typeof plugin !== 'object') continue;
  const basePlugin = basePluginMap.get(plugin.id);
  const baseVersions = new Map();
  if (basePlugin && Array.isArray(basePlugin.versions)) {
    for (const version of basePlugin.versions) {
      if (version && isNonEmptyString(version.version)) {
        baseVersions.set(version.version, version);
      }
    }
  }

  if (!Array.isArray(plugin.versions)) continue;

  const seenVersions = new Set();
  for (const version of plugin.versions) {
    const versionLabel = `${plugin.id || 'unknown'}/${version?.version || 'unknown'}`;
    if (!version || typeof version !== 'object') {
      errors.push(`pr index.json: version "${versionLabel}" must be an object`);
      continue;
    }
    if (!isNonEmptyString(version.version)) {
      errors.push(`pr index.json: version "${versionLabel}" missing version`);
    } else if (seenVersions.has(version.version)) {
      errors.push(`pr index.json: duplicate version "${version.version}" in "${plugin.id}"`);
    } else {
      seenVersions.add(version.version);
    }

    if (!version.entry || version.entry.type !== 'file' || !isValidPath(version.entry.path)) {
      errors.push(`pr index.json: version "${versionLabel}" entry must be type "file" with dist/ path`);
    }

    if (!version.dist || version.dist.type !== 'tgz' || !isNonEmptyString(version.dist.url) || !isValidSha256(String(version.dist.sha256 || '').toLowerCase())) {
      errors.push(`pr index.json: version "${versionLabel}" dist must include type "tgz", url, sha256`);
    } else {
      try {
        const url = new URL(version.dist.url);
        if (url.protocol !== 'https:') {
          errors.push(`pr index.json: version "${versionLabel}" dist.url must use https`);
        }
        if (!url.pathname.endsWith('.tgz')) {
          errors.push(`pr index.json: version "${versionLabel}" dist.url must end with .tgz`);
        }
      } catch {
        errors.push(`pr index.json: version "${versionLabel}" dist.url is invalid`);
      }
    }


    // permissions 是可选的，只在存在时验证格式
    if (version.permissions !== undefined) {
      const permissions = version.permissions;
      if (typeof permissions !== 'object' || permissions === null) {
        errors.push(`pr index.json: version "${versionLabel}" permissions must be an object`);
      } else {
        if (permissions.instances !== undefined) {
          if (!Array.isArray(permissions.instances)) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.instances must be an array`);
          } else if (permissions.instances.some((value) => !Number.isInteger(value) || value < 0)) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.instances must be non-negative integers`);
          }
        }
        if (permissions.network !== undefined) {
          if (!Array.isArray(permissions.network)) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.network must be an array`);
          } else if (permissions.network.some((value) => !isNonEmptyString(value))) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.network must be strings`);
          }
        }
        if (permissions.fs !== undefined) {
          if (!Array.isArray(permissions.fs)) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.fs must be an array`);
          } else if (permissions.fs.some((value) => !isNonEmptyString(value))) {
            errors.push(`pr index.json: version "${versionLabel}" permissions.fs must be strings`);
          }
        }
      }
    }


    const baseVersion = baseVersions.get(version.version);
    if (baseVersion) {
      const baseCanonical = stableStringify(baseVersion);
      const prCanonical = stableStringify(version);
      if (baseCanonical !== prCanonical) {
        errors.push(`pr index.json: version "${versionLabel}" modifies existing version`);
      }
      continue;
    }

    if (version.dist?.url && version.dist?.sha256) {
      downloads.push({
        label: versionLabel,
        url: version.dist.url,
        sha256: String(version.dist.sha256).toLowerCase(),
      });
    }
  }
}

async function checkDownload({ label, url, sha256 }) {
  const response = await fetch(url);
  if (!response.ok) {
    errors.push(`dist download failed for "${label}": ${response.status} ${response.statusText}`);
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (hash !== sha256) {
    errors.push(`dist sha256 mismatch for "${label}"`);
  }
}

for (const item of downloads) {
  await checkDownload(item);
}

const result = { ok: errors.length === 0, errors };

if (outPath) {
  await fs.writeFile(outPath, JSON.stringify(result, null, 2));
}

if (!result.ok) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log('validate-marketplace-pr: ok');
