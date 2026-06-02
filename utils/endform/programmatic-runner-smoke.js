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

const fs = require("fs");
const os = require("os");
const path = require("path");

function parseArgs() {
  const result = { playwrightRoot: process.cwd() };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--playwright-root")
      result.playwrightRoot = path.resolve(process.argv[++i]);
    else if (arg.startsWith("--playwright-root="))
      result.playwrightRoot = path.resolve(
        arg.substring("--playwright-root=".length),
      );
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function requireFirst(candidates, label) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch (e) {
      errors.push(`${candidate}: ${e.message}`);
    }
  }
  throw new Error(
    [
      `Could not load ${label}.`,
      `Tried:`,
      ...candidates.map((candidate) => `  ${candidate}`),
      `Build Playwright first, or pass --playwright-root to a built patched checkout/package.`,
      ...errors.map((error) => `  ${error}`),
    ].join("\n"),
  );
}

function publicRunner(root) {
  return requireFirst(
    publicRunnerCandidates(root, ".js"),
    "playwright/programmatic-runner",
  );
}

function publicRunnerCandidates(root, extension) {
  return [
    path.join(
      root,
      "packages",
      "playwright",
      `programmatic-runner${extension}`,
    ),
    path.join(root, `programmatic-runner${extension}`),
    path.join(
      root,
      "node_modules",
      "playwright",
      `programmatic-runner${extension}`,
    ),
  ];
}

function firstExisting(candidates, label) {
  const result = candidates.find((candidate) => fs.existsSync(candidate));
  if (!result)
    throw new Error(
      `Could not find ${label}. Tried:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`,
    );
  return result;
}

function publicRunnerESM(root) {
  return firstExisting(
    publicRunnerCandidates(root, ".mjs"),
    "playwright/programmatic-runner ESM entry",
  );
}

function playwrightTestEntry(root) {
  return firstExisting(
    [
      path.join(root, "packages", "playwright", "test.js"),
      path.join(root, "test.js"),
      path.join(root, "node_modules", "playwright", "test.js"),
    ],
    "playwright/test entry",
  );
}

async function writeFile(filePath, text) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class SmokeReporter {
  constructor(options) {
    this.eventsFile = options.eventsFile;
    this.events = [];
    this.stdoutWithTest = false;
    this.stderrWithTest = false;
    this.attachments = [];
  }

  version() {
    return "v2";
  }

  onConfigure(config) {
    this.events.push("onConfigure");
    this.configMetadata = config.metadata;
  }

  onBegin(suite) {
    this.events.push("onBegin");
    this.testCount = suite.allTests().length;
  }

  onTestBegin(test, result) {
    this.events.push("onTestBegin");
    this.testTitle = test.title;
    this.workerIndex = result.workerIndex;
  }

  onStepBegin(test, result, step) {
    this.events.push("onStepBegin:" + step.title);
  }

  onStepEnd(test, result, step) {
    this.events.push("onStepEnd:" + step.title);
  }

  onStdOut(chunk, test, result) {
    if (String(chunk).includes("stdout-from-programmatic-test")) {
      this.events.push("onStdOut");
      this.stdoutWithTest = !!test && !!result;
    }
  }

  onStdErr(chunk, test, result) {
    if (String(chunk).includes("stderr-from-programmatic-test")) {
      this.events.push("onStdErr");
      this.stderrWithTest = !!test && !!result;
    }
  }

  onTestEnd(test, result) {
    this.events.push("onTestEnd:" + result.status);
    this.resultErrors = result.errors.map((error) => error.message);
    this.attachments = result.attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      body: a.body && a.body.toString(),
    }));
  }

  onError(error) {
    this.events.push("onError");
    this.errors = this.errors || [];
    this.errors.push(error.message);
  }

  onEnd(result) {
    this.events.push("onEnd:" + result.status);
    this.finalStatus = result.status;
  }

  onExit() {
    this.events.push("onExit");
    fs.writeFileSync(
      this.eventsFile,
      JSON.stringify({
        events: this.events,
        configMetadata: this.configMetadata,
        finalStatus: this.finalStatus,
        testCount: this.testCount,
        testTitle: this.testTitle,
        stdoutWithTest: this.stdoutWithTest,
        stderrWithTest: this.stderrWithTest,
        attachments: this.attachments,
        resultErrors: this.resultErrors || [],
        errors: this.errors || [],
      }),
    );
  }
}

async function main() {
  const { playwrightRoot } = parseArgs();
  const runner = publicRunner(playwrightRoot);
  const esmRunner = await import(publicRunnerESM(playwrightRoot));
  assert(
    typeof esmRunner.runTests === "function",
    "Expected ESM entry to export runTests",
  );
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pw-programmatic-runner-smoke-"),
  );
  const configFile = path.join(tmpDir, "playwright.config.js");
  const reporterFile = path.join(tmpDir, "smoke-reporter.js");
  const eventsFile = path.join(tmpDir, "smoke-events.json");
  const testFile = path.join(tmpDir, "programmatic-smoke.spec.js");
  const testEntry = playwrightTestEntry(playwrightRoot);
  const preforkedWorkers = await runner.createPreforkedWorkers({ workers: 1 });

  await writeFile(
    path.join(tmpDir, "node_modules", "@playwright", "test", "index.js"),
    `module.exports = require(${JSON.stringify(testEntry)});\n`,
  );
  await writeFile(
    reporterFile,
    `const fs = require('fs');\nmodule.exports = ${SmokeReporter.toString()};\n`,
  );
  await writeFile(
    configFile,
    `
module.exports = {
  testDir: ${JSON.stringify(tmpDir)},
  testMatch: /programmatic-smoke\.spec\.js/,
  workers: 4,
  metadata: { fromConfigFile: true },
  reporter: './local-only-reporter.js',
  use: { storageState: { origins: [{ origin: 'https://top-level.example', localStorage: [] }] } },
  projects: [{
    name: 'programmatic-project',
    use: { storageState: { origins: [{ origin: 'https://project-level.example', localStorage: [] }] } },
  }],
};
`,
  );
  await writeFile(
    testFile,
    `
const { test, expect } = require('@playwright/test');

test('programmatic smoke', async ({}, testInfo) => {
  expect(process.env.ENDFORM_LATE_ENV).toBe('from-init');
  expect(testInfo.project.use.storageState.origins[0].origin).toBe('https://project-level.example');
  console.log('stdout-from-programmatic-test');
  console.error('stderr-from-programmatic-test');
  await test.step('programmatic step', async () => {
    expect(1 + 1).toBe(2);
  });
  await testInfo.attach('programmatic-attachment', {
    body: Buffer.from('attachment-body'),
    contentType: 'text/plain',
  });
});

test('not selected', async () => {
  throw new Error('This test should not run');
});
`,
  );

  try {
    const config = await runner.loadUserConfig(configFile);
    config.workers = 1;
    config.reporter = [[reporterFile, { eventsFile }]];
    config.metadata = { fromMutatedConfig: true };

    const result = await runner.runTests({
      configLocation: configFile,
      config,
      ignoreProjectDependencies: true,
      testSelection: {
        tests: [
          {
            projectName: "programmatic-project",
            file: testFile,
            titlePath: ["programmatic smoke"],
          },
        ],
      },
      preforkedWorkers,
      workerEnv: { ENDFORM_LATE_ENV: "from-init" },
    });
    const reporter = JSON.parse(
      await fs.promises.readFile(eventsFile, "utf-8"),
    );

    assert(
      result.status === "passed",
      `Expected run status passed, got ${result.status}. Test count: ${reporter.testCount}. Events: ${reporter.events.join(", ")}. Errors: ${JSON.stringify(reporter.errors || [])}. Result errors: ${JSON.stringify(reporter.resultErrors || [])}`,
    );
    assert(
      reporter.finalStatus === "passed",
      `Expected reporter final status passed, got ${reporter.finalStatus}`,
    );
    assert(
      reporter.testCount === 1,
      `Expected one test in onBegin, got ${reporter.testCount}`,
    );
    assert(
      reporter.testTitle === "programmatic smoke",
      `Expected programmatic smoke test, got ${reporter.testTitle}`,
    );
    assert(
      reporter.configMetadata.fromMutatedConfig,
      `Expected mutated metadata, got ${JSON.stringify(reporter.configMetadata)}`,
    );
    assert(
      reporter.stdoutWithTest,
      "Expected stdout to be attributed to test/result",
    );
    assert(
      reporter.stderrWithTest,
      "Expected stderr to be attributed to test/result",
    );
    assert(
      reporter.events.includes("onStepBegin:programmatic step"),
      `Missing step begin. Events: ${reporter.events.join(", ")}`,
    );
    assert(
      reporter.events.includes("onStepEnd:programmatic step"),
      `Missing step end. Events: ${reporter.events.join(", ")}`,
    );
    assert(
      reporter.attachments.some(
        (a) =>
          a.name === "programmatic-attachment" && a.body === "attachment-body",
      ),
      `Missing attachment. Attachments: ${JSON.stringify(reporter.attachments)}`,
    );
    for (const event of [
      "onConfigure",
      "onBegin",
      "onTestBegin",
      "onStdOut",
      "onStdErr",
      "onTestEnd:passed",
      "onEnd:passed",
      "onExit",
    ])
      assert(
        reporter.events.includes(event),
        `Missing reporter event ${event}. Events: ${reporter.events.join(", ")}`,
      );

    console.log("PROGRAMMATIC_RUNNER_SMOKE_OK");
    console.log(JSON.stringify({ events: reporter.events }));
  } finally {
    await runner.disposePreforkedWorkers(preforkedWorkers);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exit(1);
});
