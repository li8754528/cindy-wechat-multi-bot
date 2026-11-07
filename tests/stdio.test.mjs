import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('packaged Node entry serves JSON-RPC without non-protocol stdout', () => {
  const result = spawnSync(process.execPath, ['wechat-companion/node/worker.cjs'], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'configure', params: { bots: [{ id: 'a', name: 'A', companionId: 'buddy-a', enabled: false }] } },
      { jsonrpc: '2.0', id: 2, method: 'status', params: {} },
    ].map(req => JSON.stringify(req)).join('\n') + '\n', encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(responses.map(item => item.id), [1, 2]);
  assert.equal(responses[1].result.bots[0].status, 'disconnected');
  assert.equal(responses[1].result.credentialStorage, 'not-saved');
});
test('packaged server starts when required by a Cindy-style bootstrap', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./wechat-companion/node/worker.cjs')"], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 'native-load', method: 'configure', params: { bots: [] } }) + '\n',
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim()); assert.equal(response.id, 'native-load');
  assert.ok(response.result.instanceId); assert.deepEqual(response.result.bots, []);
});
