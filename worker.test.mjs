import test from 'node:test';
import assert from 'node:assert/strict';
import {promote} from './worker.mjs';
import worker from './worker.mjs';
test('health exposes configuration status without secrets', async () => {
  const request = new Request('https://example.workers.dev/health');
  assert.equal((await worker.fetch(request,{})).status,503);
  const response = await worker.fetch(request,{ROBLOX_API_KEY:'test',GAME_SHARED_SECRET:'x'.repeat(32)});
  assert.deepEqual(await response.json(),{ok:true,status:'configured'});
});
test('unauthenticated ranking request is rejected', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/application/pass',{method:'POST',body:'{}'}),{ROBLOX_API_KEY:'test',GAME_SHARED_SECRET:'x'.repeat(32)});
  assert.equal(response.status,401);
});
test('authenticated malformed request is rejected before calling Roblox', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/application/pass',{method:'POST',headers:{Authorization:'Bearer '+'x'.repeat(32)},body:JSON.stringify({userId:42,applicationId:'id',role:255})}),{ROBLOX_API_KEY:'test',GAME_SHARED_SECRET:'x'.repeat(32)});
  assert.equal(response.status,400);
});
const root = 'groups/261343126';
const target = `${root}/roles/880589005`;
function mock(rank, member = true, targetRank = 3) {
  const writes = [];
  return {writes, cloud: async (path, options) => {
    if (options) {writes.push({path, body:JSON.parse(options.body)}); return {};}
    if (path === target) return {path:target, rank:targetRank};
    if (path.includes('/memberships?')) return {groupMemberships:member ? [{path:`${root}/memberships/42`,user:'users/42',roles:[`${root}/roles/1`]}] : []};
    if (path === `${root}/roles/1`) return {rank};
    throw new Error('Unexpected API request');
  }};
}
test('eligible member receives configured role', async () => {
  const m = mock(1); assert.equal((await promote(42,m.cloud)).status,'promoted');
  assert.deepEqual(m.writes,[{path:`${root}/memberships/42:assignRole`,body:{role:target}}]);
});
test('existing trainee and higher staff are preserved', async () => {
  for (const rank of [3,10,255]) {const m = mock(rank); assert.equal((await promote(42,m.cloud)).status,'already_ranked'); assert.equal(m.writes.length,0);}
});
test('nonmembers cannot be ranked', async () => {const m = mock(0,false); assert.equal((await promote(42,m.cloud)).ok,false); assert.equal(m.writes.length,0);});
test('incorrect role configuration blocks writes', async () => {const m = mock(1,true,4); await assert.rejects(promote(42,m.cloud)); assert.equal(m.writes.length,0);});
test('unknown current rank fails closed', async () => {const m = mock(undefined); await assert.rejects(promote(42,m.cloud)); assert.equal(m.writes.length,0);});

