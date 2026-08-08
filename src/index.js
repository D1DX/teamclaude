#!/usr/bin/env node
import { installEnvProxyDispatcher } from './infra/egress.js';
import { main } from './cli/main.js';

// D1DX patch (DL-4333): install the env-driven proxy dispatcher before any
// command runs. Module evaluation performs no fetch, so here is early enough
// for every outbound request in the process.
await installEnvProxyDispatcher();
await main(process.argv.slice(2));
