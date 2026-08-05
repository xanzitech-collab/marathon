const http = require('http');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

(async () => {
  const loginRes = await request('http://127.0.0.1:3001/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'marathon', password: 'marathon364' }),
  });
  const cookieHeader = (loginRes.headers['set-cookie'] || []).join('; ');
  const discoverRes = await request('http://127.0.0.1:3001/api/bots/5d1e5f4a-c7be-4e67-bbf1-b22d68d07005/discover', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
    },
    body: JSON.stringify({ dryRun: true }),
  });
  console.log('login status', loginRes.status);
  console.log('login body', loginRes.body);
  console.log('discover status', discoverRes.status);
  console.log(discoverRes.body);
})();
