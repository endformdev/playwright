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

import { configLoader, ipc } from './common';
import { testRunner, workerHost } from './runner';

import type { ConfigLocation } from './common';
import type { StructuredTestSelection } from './runner/loadUtils';
import type { AnyReporter } from './reporters/reporterV2';
import type { Config } from '../types/test';
import type { FullResult } from '../types/testReporter';

type ConfigLocationInput = string | ConfigLocation;

type RunTestsParams = {
  configLocation: ConfigLocationInput;
  config?: Config;
  configOverrides?: ipc.ConfigCLIOverrides;
  ignoreProjectDependencies?: boolean;
  projectFilter?: string[];
  locations?: string[];
  grep?: string;
  grepInvert?: string;
  testSelection?: StructuredTestSelection;
  reporter?: AnyReporter | AnyReporter[];
  disableConfigReporters?: boolean;
  preforkedWorkers?: PreforkedWorkers;
  workerEnv?: Record<string, string | undefined>;
  metadata?: Config['metadata'];
  passWithNoTests?: boolean;
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

export async function loadUserConfig(location: ConfigLocationInput): Promise<Config> {
  return await configLoader.loadUserConfig(resolveLocation(location));
}

export async function runTests(params: RunTestsParams): Promise<RunTestsResult> {
  const location = resolveLocation(params.configLocation);
  const userConfig = params.config || await configLoader.loadUserConfig(location, params.configOverrides);
  const metadata = params.metadata ?? (params.configOverrides as any)?.metadata;
  const config = await configLoader.loadConfigFromObject(location, userConfig, params.configOverrides, params.ignoreProjectDependencies, metadata);
  const reporters = params.reporter ? Array.isArray(params.reporter) ? params.reporter : [params.reporter] : [];
  const status = await testRunner.runAllTestsWithConfig(config, {
    locations: params.locations,
    grep: params.grep,
    grepInvert: params.grepInvert,
    projectFilter: params.projectFilter,
    testSelection: params.testSelection,
    passWithNoTests: params.passWithNoTests,
    additionalReporterObjects: reporters,
    disableConfigReporters: params.disableConfigReporters,
    preforkedWorkers: params.preforkedWorkers?.workers,
    workerEnv: params.workerEnv,
  });
  return { status };
}

export async function createPreforkedWorkers(params: { workers: number }): Promise<PreforkedWorkers> {
  const workers: workerHost.WorkerHost[] = [];
  try {
    for (let i = 0; i < params.workers; i++) {
      const worker = new workerHost.WorkerHost(i);
      workers.push(worker);
      const error = await worker.prefork();
      if (error)
        throw new Error(`Worker process exited before it was ready (code=${error.code}, signal=${error.signal})`);
    }
  } catch (e) {
    await Promise.all(workers.map(worker => worker.stop().catch(() => {})));
    throw e;
  }
  return new PreforkedWorkers(workers);
}

export async function disposePreforkedWorkers(workers: PreforkedWorkers): Promise<void> {
  await Promise.all(workers.workers.map(worker => worker.stop().catch(() => {})));
}

function resolveLocation(location: ConfigLocationInput): ConfigLocation {
  if (typeof location === 'string')
    return configLoader.resolveConfigLocation(location);
  return location;
}
