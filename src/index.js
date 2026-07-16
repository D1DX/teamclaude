#!/usr/bin/env node
import { main } from './cli/main.js';
await main(process.argv.slice(2));
