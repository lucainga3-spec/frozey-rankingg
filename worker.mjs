export async function promote(userId, cloud) {
  const group = '261343126';
  const target = `groups/${group}/roles/880589005`;
  const role = await cloud(target);
  if (role.path !== target || role.rank !== 3) throw new Error('Trainee role configuration does not match rank 3');
  const query = new URLSearchParams({filter: `user == 'users/${userId}'`, maxPageSize: '10'});
  const data = await cloud(`groups/${group}/memberships?${query}`);
  const membership = data.groupMemberships?.find(m => m.user === `users/${userId}`);
  if (!membership) return {ok:false, status:'not_in_group'};
  const membershipPath = `groups/${group}/memberships/${userId}`;
  const paths = membership.roles?.length ? membership.roles : (membership.role ? [membership.role] : []);
  if (!paths.length) throw new Error('Cannot determine current roles');
  for (const path of paths) {
    if (!new RegExp(`^groups/${group}/roles/\\d+$`).test(path)) throw new Error('Invalid role path');
    const current = await cloud(path);
    if (!Number.isInteger(current.rank)) throw new Error('Cannot determine current rank');
    if (current.rank >= 3) return {ok:true, status:'already_ranked'};
  }
  await cloud(`${membershipPath}:assignRole`, {method:'POST', body:JSON.stringify({role:target})});
  return {ok:true, status:'promoted'};
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type':'application/json', 'Cache-Control':'no-store'}
});

async function sameSecret(a, b) {
  const encode = new TextEncoder();
  const left = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(a)));
  const right = new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(b)));
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') {
      const ready = !!env.ROBLOX_API_KEY && typeof env.GAME_SHARED_SECRET === 'string' && env.GAME_SHARED_SECRET.length >= 32;
      return json({ok:ready, status:ready ? 'configured' : 'missing_secrets'}, ready ? 200 : 503);
    }
    if (request.method !== 'POST' || path !== '/application/pass') return json({ok:false,status:'not_found'},404);
    if (!env.ROBLOX_API_KEY || typeof env.GAME_SHARED_SECRET !== 'string' || env.GAME_SHARED_SECRET.length < 32) return json({ok:false,status:'missing_secrets'},503);
    const supplied = request.headers.get('Authorization') || '';
    if (supplied.length > 1024 || !await sameSecret(supplied, 'Bearer ' + env.GAME_SHARED_SECRET)) return json({ok:false,status:'unauthorized'},401);
    try {
      // Bound streamed input before parsing, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return json({ok:false,status:'invalid_json'},400);
      let length = 0;
      const parts = [];
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 2048) {await reader.cancel(); return json({ok:false,status:'body_too_large'},413);}
        parts.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of parts) {bytes.set(part,offset); offset += part.length;}
      let input;
      try {input = JSON.parse(new TextDecoder().decode(bytes));} catch {return json({ok:false,status:'invalid_json'},400);}
      if (!input || !Number.isSafeInteger(input.userId) || input.userId <= 0 || typeof input.applicationId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.applicationId)) return json({ok:false,status:'invalid_request'},400);
      if (Object.keys(input).some(k => !['userId','applicationId'].includes(k))) return json({ok:false,status:'unexpected_fields'},400);
      let calls = 0;
      async function cloud(resource, options = {}) {
        if (++calls > 40) throw new Error('Too many assigned roles');
        const response = await fetch('https://apis.roblox.com/cloud/v2/' + resource, {
          ...options, signal:AbortSignal.timeout(10000),
          headers:{'x-api-key':env.ROBLOX_API_KEY,'Content-Type':'application/json'}
        });
        if (!response.ok) {const error = new Error('Roblox API request failed'); error.upstreamStatus = response.status; throw error;}
        return response.json();
      }
      const result = await promote(input.userId, cloud);
      console.log(JSON.stringify({userId:input.userId,applicationId:input.applicationId,status:result.status}));
      return json(result,result.ok ? 200 : 409);
    } catch (error) {
      console.error(JSON.stringify({status:'ranking_failed',upstreamStatus:error.upstreamStatus || null}));
      return json({ok:false,status:'ranking_failed'},502);
    }
  }
};

