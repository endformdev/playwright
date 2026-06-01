#!/usr/bin/env node
/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'endform-packages');

const packages = [
  {
    sourceDir: path.join(ROOT, 'packages', 'playwright-core'),
    stagedName: '@endform/playwright-core',
  },
  {
    sourceDir: path.join(ROOT, 'packages', 'playwright'),
    stagedName: '@endform/playwright',
    dependencies: version => ({
      'playwright-core': `npm:@endform/playwright-core@${version}`,
    }),
  },
  {
    sourceDir: path.join(ROOT, 'packages', 'playwright-test'),
    stagedName: '@endform/playwright-test',
    dependencies: version => ({
      'playwright': `npm:@endform/playwright@${version}`,
    }),
  },
];

function parseArgs() {
  const result = {
    outDir: DEFAULT_OUT_DIR,
    skipSmoke: false,
    keepTemp: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--out-dir')
      result.outDir = path.resolve(process.argv[++i]);
    else if (arg.startsWith('--out-dir='))
      result.outDir = path.resolve(arg.substring('--out-dir='.length));
    else if (arg === '--skip-smoke')
      result.skipSmoke = true;
    else if (arg === '--keep-temp')
      result.keepTemp = true;
    else if (arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function usage() {
  console.log(`usage: stage_endform_packages.js [--out-dir <path>] [--skip-smoke] [--keep-temp]\n\nStages @endform Playwright packages by packing the canonical workspace packages, rewriting only staged package metadata, and producing final tarballs.`);
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout ? result.stdout.trim() : '';
}

async function rm(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function readJSON(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

async function writeJSON(file, object) {
  await fs.promises.writeFile(file, JSON.stringify(object, null, 2) + '\n');
}

function tarballBaseName(name, version) {
  const unscoped = name.replace(/^@/, '').replace('/', '-');
  return `${unscoped}-${version}.tgz`;
}

async function packSourcePackage(sourceDir, tempDir) {
  const packDir = path.join(tempDir, 'source-packs');
  await fs.promises.mkdir(packDir, { recursive: true });
  const output = run('npm', ['pack', sourceDir, '--pack-destination', packDir], { capture: true });
  const tgzName = output.split('\n').filter(Boolean).pop();
  return path.join(packDir, tgzName);
}

async function extractPackage(tgzPath, destination) {
  await fs.promises.mkdir(destination, { recursive: true });
  run('tar', ['-xzf', tgzPath, '-C', destination]);
  return path.join(destination, 'package');
}

async function rewritePackageJSON(packageDir, descriptor, version) {
  const packageJSONPath = path.join(packageDir, 'package.json');
  const packageJSON = await readJSON(packageJSONPath);
  packageJSON.name = descriptor.stagedName;
  packageJSON.version = version;
  if (descriptor.dependencies)
    packageJSON.dependencies = descriptor.dependencies(version);
  await writeJSON(packageJSONPath, packageJSON);
}

async function packStagedPackage(packageDir, outDir, expectedName) {
  const output = run('npm', ['pack', packageDir, '--pack-destination', outDir], { capture: true });
  const tgzName = output.split('\n').filter(Boolean).pop();
  const tgzPath = path.join(outDir, tgzName);
  const expectedPath = path.join(outDir, expectedName);
  if (tgzPath !== expectedPath) {
    await fs.promises.rename(tgzPath, expectedPath);
    return expectedPath;
  }
  return tgzPath;
}

async function smokeInstall(tarballs, version) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endform-playwright-smoke-'));
  try {
    // Local pre-publish validation uses the same canonical alias shape LambdaRunner
    // installs in its isolated Endform root. Direct scoped installation requires
    // the scoped packages to already exist in the npm registry because staged
    // package dependencies intentionally use npm aliases.
    await writeJSON(path.join(tempDir, 'package.json'), {
      private: true,
      dependencies: {
        'playwright-core': tarballs['@endform/playwright-core'],
        'playwright': tarballs['@endform/playwright'],
        '@playwright/test': tarballs['@endform/playwright-test'],
      },
    });
    run('npm', ['install', '--ignore-scripts'], { cwd: tempDir });
    run('node', ['-e', [
      `const core = require('playwright-core/package.json');`,
      `const pw = require('playwright/package.json');`,
      `const pwt = require('@playwright/test/package.json');`,
      `if (core.version !== ${JSON.stringify(version)} || pw.version !== ${JSON.stringify(version)} || pwt.version !== ${JSON.stringify(version)}) throw new Error('version mismatch');`,
      `if (pw.dependencies['playwright-core'] !== ${JSON.stringify(`npm:@endform/playwright-core@${version}`)}) throw new Error('bad playwright-core alias');`,
      `if (pwt.dependencies.playwright !== ${JSON.stringify(`npm:@endform/playwright@${version}`)}) throw new Error('bad playwright alias');`,
      `require('playwright');`,
      `require('playwright/test');`,
      `require('playwright/programmatic-runner');`,
      `require('@playwright/test');`,
    ].join('')], { cwd: tempDir });
  } finally {
    await rm(tempDir);
  }
}

async function main() {
  const options = parseArgs();
  const version = (await readJSON(path.join(ROOT, 'package.json'))).version;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endform-playwright-stage-'));
  const tarballs = {};
  try {
    await rm(options.outDir);
    await fs.promises.mkdir(options.outDir, { recursive: true });
    for (const descriptor of packages) {
      const sourceTgz = await packSourcePackage(descriptor.sourceDir, tempDir);
      const packageDir = await extractPackage(sourceTgz, path.join(tempDir, descriptor.stagedName.replace('/', '-').replace('@', '')));
      await rewritePackageJSON(packageDir, descriptor, version);
      const outputName = tarballBaseName(descriptor.stagedName, version);
      tarballs[descriptor.stagedName] = await packStagedPackage(packageDir, options.outDir, outputName);
    }

    if (!options.skipSmoke)
      await smokeInstall(tarballs, version);

    console.log(JSON.stringify({ version, outDir: options.outDir, tarballs }, null, 2));
  } finally {
    if (options.keepTemp)
      console.error(`Kept temp staging directory: ${tempDir}`);
    else
      await rm(tempDir);
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
