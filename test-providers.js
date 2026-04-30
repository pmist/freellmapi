const fetch = require('node-fetch');
const dbPkg = require('better-sqlite3');
const crypto = require('crypto');

const db = dbPkg('server/data/freeapi.db');

function decrypt(encrypted, ivHex, authTagHex) {
  const sysRow = db.prepare('SELECT value FROM settings WHERE key=\'encryption_key\'').get();
  const masterKey = Buffer.from(sysRow.value, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function testProvider(platform, url, model, headers = {}, bodyTransformer = b => b) {
  const row = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=1 LIMIT 1').get(platform);
  if (!row) {
    console.log(`No key for ${platform}`);
    return;
  }
  const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  
  const body = {
    model: model,
    messages: [{role: 'user', content: 'What is the weather in London?'}],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        strict: true,
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
          additionalProperties: false
        }
      }
    }]
  };

  const finalHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...headers
  };
  
  if (platform === 'cloudflare') {
    const parts = apiKey.split(':');
    url = `https://api.cloudflare.com/client/v4/accounts/${parts[0]}/ai/v1/chat/completions`;
    finalHeaders['Authorization'] = `Bearer ${parts[1]}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: finalHeaders,
    body: JSON.stringify(bodyTransformer(body))
  });
  
  if (res.ok) {
    console.log(`[${platform}] OK`);
  } else {
    console.log(`[${platform}] ERROR ${res.status}: ${await res.text()}`);
  }
}

async function run() {
  await testProvider('cohere', 'https://api.cohere.ai/compatibility/v1/chat/completions', 'command-r-plus-08-2024');
  await testProvider('cloudflare', '', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  await testProvider('groq', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile');
  await testProvider('sambanova', 'https://api.sambanova.ai/v1/chat/completions', 'Meta-Llama-3.3-70B-Instruct');
}
run();
