// Minimal Jira Cloud REST v3 stand-in for the E2E export test (no external deps).
//
// Served on 127.0.0.1 rather than localhost for two reasons: the host is already
// in the manifest's host_permissions (so chrome.permissions.request resolves
// without a blocking prompt), and normalizeSiteUrl requires a dotted hostname.
//
// Every request is recorded and exposed at GET /__requests so the test can
// assert on the ADF payload and the attachment multipart.
import { createServer } from 'node:http';

const port = Number(process.env.JIRA_MOCK_PORT ?? 5556);

/** @type {{method:string,path:string,headers:Record<string,string>,body:string}[]} */
const requests = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (url.pathname === '/__requests') {
    json(res, 200, requests);
    return;
  }
  if (url.pathname === '/__reset') {
    requests.length = 0;
    json(res, 200, { ok: true });
    return;
  }

  const raw = await readBody(req);
  requests.push({
    method: req.method ?? 'GET',
    path: url.pathname,
    headers: req.headers,
    body: raw.toString('utf8'),
  });

  // Every real endpoint is authenticated; the test asserts the header shape.
  if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
    json(res, 401, { errorMessages: ['Client must be authenticated'] });
    return;
  }

  if (url.pathname === '/rest/api/3/myself') {
    json(res, 200, {
      accountId: 'acc-1',
      displayName: 'QA Bot',
      emailAddress: 'qa@acme.io',
      avatarUrls: { '24x24': 'https://example.invalid/a.png' },
    });
    return;
  }

  if (url.pathname.startsWith('/rest/api/3/issue/createmeta/')) {
    json(res, 200, {
      fields: [
        { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
        {
          fieldId: 'customfield_101',
          name: 'Team',
          required: true,
          schema: { type: 'option' },
          allowedValues: [{ id: '5', value: 'Payments' }],
        },
      ],
    });
    return;
  }

  if (url.pathname === '/rest/api/3/issue' && req.method === 'POST') {
    json(res, 201, { id: '10001', key: 'QA-101', self: `http://127.0.0.1:${port}/rest/api/3/issue/10001` });
    return;
  }

  if (/^\/rest\/api\/3\/issue\/[^/]+\/attachments$/.test(url.pathname) && req.method === 'POST') {
    if (req.headers['x-atlassian-token'] !== 'no-check') {
      json(res, 403, { errorMessages: ['XSRF check failed'] });
      return;
    }
    json(res, 200, [{ id: '1', filename: 'uploaded' }]);
    return;
  }

  json(res, 404, { errorMessages: ['Not found'] });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`jira mock on http://127.0.0.1:${port}`);
});
