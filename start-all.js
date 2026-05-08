#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting settlement service and mock gateway...\n');

const gateway = spawn('node', ['dist/mock-gateway/index.js'], {
  cwd: __dirname,
  env: { ...process.env, GATEWAY_PORT: '3001' },
  stdio: 'inherit',
});

setTimeout(() => {
  const service = spawn('node', ['dist/src/index.js'], {
    cwd: __dirname,
    env: { ...process.env, GATEWAY_URL: 'http://localhost:3001' },
    stdio: 'inherit',
  });

  process.on('SIGINT', () => {
    console.log('\n⏹  Shutting down...');
    gateway.kill();
    service.kill();
    process.exit(0);
  });
}, 500);

// Handle gateway exit
gateway.on('exit', (code) => {
  if (code !== 0) {
    console.error('❌ Mock gateway exited with code', code);
  }
});
