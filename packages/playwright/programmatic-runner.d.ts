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

import type { Config } from './types/test';
import type { FullResult } from './types/testReporter';

export type ConfigLocation = string | {
  resolvedConfigFile?: string;
  configDir: string;
};

export type StructuredTestSelection = {
  tests: StructuredSelectedTest[];
};

export type StructuredSelectedTest = {
  projectName: string;
  file: string;
  titlePath: string[];
};

export type PreforkedWorkers = {
  readonly __brand: unique symbol;
};

export type RunTestsParams = {
  configLocation: ConfigLocation;
  config: Config;
  ignoreProjectDependencies: boolean;
  testSelection: StructuredTestSelection;
  preforkedWorkers: PreforkedWorkers;
  workerEnv: Record<string, string | undefined>;
};

export type RunTestsResult = {
  status: FullResult['status'];
};

export function loadUserConfig(location: ConfigLocation): Promise<Config>;
export function runTests(params: RunTestsParams): Promise<RunTestsResult>;
export function createPreforkedWorkers(params: { workers: number }): Promise<PreforkedWorkers>;
export function disposePreforkedWorkers(workers: PreforkedWorkers): Promise<void>;
