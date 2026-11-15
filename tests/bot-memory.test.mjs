import test from 'node:test';
import assert from 'node:assert/strict';
import { BotMemory } from '../src/bot-memory.mjs';
test('memory partitions by stable Bot ID, survives reload and clears only one Bot', () => {
  const memory = new BotMemory(); memory.set('a','likes tea'); memory.set('b','likes coffee');
  const restored = new BotMemory(JSON.parse(JSON.stringify(memory.records)));
  const oldRevision = restored.get('a').revision;
  restored.clear('a'); assert.equal(restored.get('a').text,'');
  assert.equal(restored.get('b').text,'likes coffee'); assert.equal(restored.get('a').revision,oldRevision+1);
  assert.equal(new BotMemory(restored.records).get('a').revision,oldRevision+1);
});
test('legacy memory migrates without losing text and invalid saved records are ignored', () => {
  const memory = new BotMemory({a:{text:'legacy'}, b:{text:42}, '../c':{text:'bad'}});
  assert.equal(memory.get('a').text,'legacy'); assert.equal(memory.get('a').revision,0);
  assert.equal(memory.get('b').text,''); assert.equal(Object.keys(memory.records).length,1);
});
