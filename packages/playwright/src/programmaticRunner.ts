/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { configLoader } from './common';
import { testRunner, workerHost } from './runner';

import type { Config } from '../types/test';
import type { FullResult } from '../types/testReporter';
import type { ConfigLocation } from './common';
import type { FullConfigInternal } from './common/config';
import type { ConfigCLIOverrides } from './common/ipc';
import type { StructuredTestSelection } from './runner/loadUtils';

type ConfigLocationInput = string | ConfigLocation;

type RunTestsParams = {
  configLocation: ConfigLocationInput;
  config: Config;
  ignoreProjectDependencies: boolean;
  testSelection: StructuredTestSelection;
  preforkedWorkers: PreforkedWorkers;
  workerEnv: Record<string, string | undefined>;
};

type RunTestsResult = {
  status: FullResult['status'];
};

export class PreforkedWorkers {
  readonly workers: workerHost.WorkerHost[];

  constructor(workers: workerHost.WorkerHost[]) {
    this.workers = workers;
  }
}

export async function loadUserConfig(
  location: ConfigLocationInput,
): Promise<Config> {
  return await configLoader.loadUserConfig(resolveLocation(location));
}

export async function runTests(
  params: RunTestsParams,
): Promise<RunTestsResult> {
  const location = resolveLocation(params.configLocation);
  await configLoader.prepareConfigLoading(location);
  const config = await configLoader.loadConfigFromObject(
      location,
      params.config,
      {},
      params.ignoreProjectDependencies,
  );
  (config as any).__programmaticUserConfig = params.config;
  applyWorkerConfigCLIOverrides(config);
  validateTestSelection(params.testSelection);
  const status = await testRunner.runAllTestsWithConfig(config, {
    projectFilter: projectFilterFromSelection(params.testSelection),
    testSelection: params.testSelection,
    preforkedWorkers: params.preforkedWorkers.workers,
    workerEnv: params.workerEnv,
  });
  return { status };
}

function validateTestSelection(selection: StructuredTestSelection) {
  if (!selection || !selection.tests.length)
    throw new Error('Programmatic runner requires at least one selected test');
  for (const test of selection.tests) {
    if (test.projectName === undefined) {
      throw new Error(
          'Programmatic runner selected test must specify projectName',
      );
    }
    if (!test.file)
      throw new Error('Programmatic runner selected test must specify file');
    if (!test.titlePath?.length) {
      throw new Error(
          'Programmatic runner selected test must specify non-empty titlePath',
      );
    }
  }
}

function projectFilterFromSelection(
  selection: StructuredTestSelection,
): string[] {
  return [...new Set(selection.tests.map(test => test.projectName))];
}

export async function createPreforkedWorkers(params: {
  workers: number;
}): Promise<PreforkedWorkers> {
  const workers: workerHost.WorkerHost[] = [];
  try {
    for (let i = 0; i < params.workers; i++) {
      const worker = new workerHost.WorkerHost(i);
      workers.push(worker);
      const error = await worker.prefork();
      if (error) {
        throw new Error(
            `Worker process exited before it was ready (code=${error.code}, signal=${error.signal})`,
        );
      }
    }
  } catch (e) {
    await Promise.all(workers.map(worker => worker.stop().catch(() => {})));
    throw e;
  }
  return new PreforkedWorkers(workers);
}

export async function disposePreforkedWorkers(
  workers: PreforkedWorkers,
): Promise<void> {
  await Promise.all(
      workers.workers.map(worker => worker.stop().catch(() => {})),
  );
}

function resolveLocation(location: ConfigLocationInput): ConfigLocation {
  if (typeof location === 'string')
    return configLoader.resolveConfigLocation(location);
  return location;
}

function applyWorkerConfigCLIOverrides(config: FullConfigInternal) {
  const overrides: ConfigCLIOverrides = {
    ...config.configCLIOverrides,
    failOnFlakyTests: config.failOnFlakyTests,
    forbidOnly: config.config.forbidOnly,
    fullyParallel: config.config.fullyParallel,
    globalTimeout: config.config.globalTimeout,
    reporter: config.config.reporter,
    quiet: config.config.quiet,
    workers: config.config.workers,
    maxFailures: config.config.maxFailures,
    shard: config.config.shard || undefined,
    updateSnapshots: config.config.updateSnapshots,
    updateSourceMethod: config.config.updateSourceMethod,
  };

  const ignoreSnapshots = commonProjectValue(config, 'ignoreSnapshots');
  if (ignoreSnapshots !== undefined)
    overrides.ignoreSnapshots = ignoreSnapshots;
  const repeatEach = commonProjectValue(config, 'repeatEach');
  if (repeatEach !== undefined)
    overrides.repeatEach = repeatEach;
  const timeout = commonProjectValue(config, 'timeout');
  if (timeout !== undefined)
    overrides.timeout = timeout;
  const retries = commonProjectValue(config, 'retries');
  if (retries !== undefined)
    overrides.retries = retries;
  const outputDir = commonProjectValue(config, 'outputDir');
  if (outputDir !== undefined)
    overrides.outputDir = outputDir;

  Object.assign(config.configCLIOverrides, overrides);
}

function commonProjectValue<
  T extends
    | 'ignoreSnapshots'
    | 'repeatEach'
    | 'timeout'
    | 'retries'
    | 'outputDir',
>(
  config: FullConfigInternal,
  property: T,
): FullConfigInternal['projects'][number]['project'][T] | undefined {
  const projects = config.projects;
  if (!projects.length)
    return undefined;
  const first = projects[0].project[property];
  return projects.every(project => project.project[property] === first)
    ? first
    : undefined;
}
