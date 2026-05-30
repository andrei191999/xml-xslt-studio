const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { runPilot, resolveVersions } = require('./phive-pilot');

const TRACKED_COMPONENT_PATTERNS = {
  ddd: /^ddd-(.+)\.jar$/i,
  phiveApi: /^phive-api-(.+)\.jar$/i,
  phiveXml: /^phive-xml-(.+)\.jar$/i,
  phiveRulesApi: /^phive-rules-api-(.+)\.jar$/i,
  phiveRulesEn16931: /^phive-rules-en16931-(.+)\.jar$/i,
  phiveRulesPeppol: /^phive-rules-peppol-(.+)\.jar$/i,
  jaxbRuntime: /^jaxb-runtime-(.+)\.jar$/i,
  phiveResultHtml: /^phive-result-html-(.+)\.jar$/i,
};

const FIXED_ZIP_DATE = new Date('2026-01-01T00:00:00Z');
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function createStackId(directVersions) {
  return `ddd-${directVersions.ddd}_phive-${directVersions.phive}_rules-${directVersions.rules}`;
}

function listTrackedJarMatches(jarsDir) {
  const names = fs.existsSync(jarsDir) ? fs.readdirSync(jarsDir) : [];
  const matches = {};
  for (const key of Object.keys(TRACKED_COMPONENT_PATTERNS)) {
    matches[key] = names.filter((name) => TRACKED_COMPONENT_PATTERNS[key].test(name));
  }
  return matches;
}

function buildStackManifestFromJars(jarsDir, directVersions, source, installedAt, healthVerifiedAt) {
  const matches = listTrackedJarMatches(jarsDir);
  const resolvedVersions = {};
  for (const key of Object.keys(TRACKED_COMPONENT_PATTERNS)) {
    const files = matches[key];
    if (files.length === 0) {
      if (key === 'phiveResultHtml') {
        continue;
      }
      throw new Error(
        `Missing tracked PHIVE component jar for ${key}`
      );
    }
    if (files.length !== 1) {
      throw new Error(`Duplicate tracked PHIVE component jars for ${key}: ${files.join(', ')}`);
    }
    const version = files[0].match(TRACKED_COMPONENT_PATTERNS[key])?.[1];
    if (!version) {
      throw new Error(`Could not parse PHIVE component version from ${files[0]}`);
    }
    resolvedVersions[key] = version;
  }

  return {
    stackId: createStackId(directVersions),
    source,
    installedAt,
    healthVerifiedAt,
    primaryRulesVersion: resolvedVersions.phiveRulesPeppol,
    directVersions,
    resolvedVersions,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  ensureDir(dirPath);
}

function listFilesRecursively(rootDir) {
  const files = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported file type in curated stack directory: ${fullPath}`);
      }
      files.push(fullPath);
    }
  }
  walk(rootDir);
  return files;
}

const ZIP32_MAX_ENTRIES = 65535;
const ZIP32_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB

function writeDeterministicZip(inputDir, outputFile) {
  const { time, date } = toDosDateTime(FIXED_ZIP_DATE);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const allFiles = listFilesRecursively(inputDir);

  // E3 — ZIP64 size guard
  if (allFiles.length > ZIP32_MAX_ENTRIES) {
    throw new Error(`Curated bundle contains ${allFiles.length} entries, exceeding the ZIP32 limit of ${ZIP32_MAX_ENTRIES}.`);
  }
  let totalUncompressed = 0;
  for (const fullPath of allFiles) {
    totalUncompressed += fs.statSync(fullPath).size;
  }
  if (totalUncompressed > ZIP32_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`Curated bundle total uncompressed size (${totalUncompressed} bytes) exceeds the ZIP32 limit of ${ZIP32_MAX_UNCOMPRESSED_BYTES} bytes.`);
  }

  for (const fullPath of allFiles) {
    const relativePath = path.relative(inputDir, fullPath).split(path.sep).join('/');
    const fileName = Buffer.from(relativePath, 'utf8');
    const rawData = fs.readFileSync(fullPath);
    const compressedData = zlib.deflateRawSync(rawData, { level: 9 });
    const checksum = crc32(rawData);
    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileName.copy(localHeader, 30);
    localParts.push(localHeader, compressedData);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    fileName.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(centralParts.length, 8);
  endRecord.writeUInt16LE(centralParts.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  ensureDir(path.dirname(outputFile));
  fs.writeFileSync(outputFile, Buffer.concat([...localParts, centralDirectory, endRecord]));
}

function detectRepositorySlug(packageJson) {
  const rawUrl = packageJson.repository?.url || packageJson.homepage || '';
  const normalized = rawUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  if (!match) {
    throw new Error('Could not determine the GitHub repository slug from package.json.');
  }
  return match[1];
}

function compareFeedStackOrder(left, right) {
  if (left.publishedAt !== right.publishedAt) {
    return left.publishedAt > right.publishedAt ? -1 : 1;
  }
  if (left.stackId !== right.stackId) {
    return left.stackId < right.stackId ? -1 : 1;
  }
  return 0;
}

function normalizeFeedStacks(stacks) {
  return (Array.isArray(stacks) ? stacks : [])
    .filter((stack) => stack && typeof stack === 'object')
    .slice()
    .sort(compareFeedStackOrder);
}

function buildCanonicalFeed(stacks) {
  return {
    schemaVersion: 1,
    channel: 'stable',
    stacks: normalizeFeedStacks(stacks),
  };
}

function loadExistingFeed(feedPath) {
  if (!fs.existsSync(feedPath)) {
    return {
      schemaVersion: 1,
      generatedAt: '',
      channel: 'stable',
      stacks: [],
    };
  }
  return JSON.parse(fs.readFileSync(feedPath, 'utf8'));
}

function curate() {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const versions = resolveVersions();
  const publishedAt = process.env.PHIVE_PUBLISHED_AT || new Date().toISOString();
  const minimumExtensionVersion = process.env.PHIVE_MIN_EXTENSION_VERSION || packageJson.version;
  const minimumJavaMajor = Number(process.env.PHIVE_MIN_JAVA_MAJOR || '17');
  const source = process.env.PHIVE_SOURCE || 'github-release';
  const outputDir = process.env.PHIVE_CURATE_OUT_DIR || path.join(root, 'dist', 'phive');
  const feedPath = process.env.PHIVE_FEED_PATH || path.join(root, 'docs', 'phive', 'stable.json');
  const repositorySlug = detectRepositorySlug(packageJson);
  const jarsDir = path.join(root, 'lib', 'phive-jars');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-xslt-phive-curate-'));
  const stackDir = path.join(tempRoot, 'stack');

  if (!Number.isInteger(minimumJavaMajor) || minimumJavaMajor < 1) {
    throw new Error('PHIVE_MIN_JAVA_MAJOR must be a positive integer.');
  }
  if (!fs.existsSync(jarsDir)) {
    throw new Error(`Bundled PHIVE jars directory not found: ${jarsDir}`);
  }

  try {
    try {
      runPilot({ root, versions });
    } catch (pilotError) {
      console.error(`[phive:curate] Pilot/Maven failed: ${pilotError.message || pilotError}`);
      process.exitCode = 1;
      return;
    }

    cleanDir(stackDir);
    for (const entry of fs.readdirSync(jarsDir).sort()) {
      if (!entry.toLowerCase().endsWith('.jar')) {
        continue;
      }
      fs.copyFileSync(path.join(jarsDir, entry), path.join(stackDir, entry));
    }

    const manifest = buildStackManifestFromJars(stackDir, versions, source, publishedAt, publishedAt);
    fs.writeFileSync(path.join(stackDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const releaseTag = `phive-stack-${manifest.stackId}`;
    const assetName = `${releaseTag}.zip`;
    const assetPath = path.join(outputDir, assetName);
    writeDeterministicZip(stackDir, assetPath);

    const assetBytes = fs.readFileSync(assetPath);
    const sha256 = crypto.createHash('sha256').update(assetBytes).digest('hex');
    const feedEntry = {
      stackId: manifest.stackId,
      publishedAt,
      source,
      directVersions: versions,
      minimumExtensionVersion,
      minimumJavaMajor,
      bundle: {
        assetName,
        url: `https://github.com/${repositorySlug}/releases/download/${releaseTag}/${assetName}`,
        sizeBytes: assetBytes.length,
        sha256,
      },
    };

    const feed = loadExistingFeed(feedPath);
    const mergedStacks = normalizeFeedStacks([
      feedEntry,
      ...normalizeFeedStacks(feed.stacks).filter((stack) => stack.stackId !== feedEntry.stackId),
    ]);
    const previousCanonical = buildCanonicalFeed(feed.stacks);
    const nextCanonical = buildCanonicalFeed(mergedStacks);
    const contentUnchanged = JSON.stringify(previousCanonical) === JSON.stringify(nextCanonical);
    const generatedAt = contentUnchanged
      ? (feed.generatedAt || mergedStacks[0]?.publishedAt || publishedAt)
      : (process.env.PHIVE_GENERATED_AT || mergedStacks[0]?.publishedAt || publishedAt);
    const nextFeed = {
      ...nextCanonical,
      generatedAt,
    };

    ensureDir(path.dirname(feedPath));
    fs.writeFileSync(feedPath, JSON.stringify(nextFeed, null, 2) + '\n', 'utf8');

    console.log('[phive:curate] Curated stack ready');
    console.log(`  stackId: ${manifest.stackId}`);
    console.log(`  asset:   ${assetPath}`);
    console.log(`  feed:    ${feedPath}`);
    console.log(JSON.stringify(feedEntry, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  curate();
}

module.exports = {
  buildCanonicalFeed,
  normalizeFeedStacks,
  curate,
};
