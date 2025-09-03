const http = require('http');
const url = require('url');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 8080;
const DEBUG = process.env.DEBUG || '';
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'load';
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS) || 15000;
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS) || 30000;
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',').map(h => h.trim()) : [];

function log(data) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    ...data
  }));
}

function validateUrl(urlString) {
  if (!urlString) {
    return { valid: false, error: "Missing 'url' parameter" };
  }
  
  if (urlString.length > 2048) {
    return { valid: false, error: "URL too long (max 2048 characters)" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (e) {
    return { valid: false, error: "Invalid URL format" };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { valid: false, error: "Only HTTP(S) URLs are allowed" };
  }

  if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    return { valid: false, error: "Host not in allowed list" };
  }

  return { valid: true };
}

async function getPageTitle(targetUrl) {
  const startTime = Date.now();
  let browser = null;
  let page = null;
  
  try {
    const traceId = Math.random().toString(36).substr(2, 9);
    
    log({
      traceId,
      event: 'request_start',
      url: targetUrl,
      start_ts: startTime
    });

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions'
      ]
    });

    page = await browser.newPage();
    
    const response = await page.goto(targetUrl, {
      waitUntil: WAIT_UNTIL,
      timeout: NAV_TIMEOUT_MS
    });

    const title = await page.title();
    const endTime = Date.now();
    const timing = endTime - startTime;

    log({
      traceId,
      event: 'request_success',
      url: targetUrl,
      start_ts: startTime,
      end_ts: endTime,
      timing_ms: timing,
      status: response.status(),
      outcome: 'success'
    });

    return {
      ok: true,
      title,
      url: targetUrl,
      status: response.status(),
      timing_ms: timing
    };

  } catch (error) {
    const endTime = Date.now();
    const timing = endTime - startTime;
    
    let errorCode = 'UNKNOWN_ERROR';
    let httpStatus = 502;
    
    if (error.message.includes('timeout')) {
      errorCode = 'NAV_TIMEOUT';
      httpStatus = 504;
    } else if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      errorCode = 'DNS_FAIL';
      httpStatus = 502;
    } else if (error.message.includes('net::')) {
      errorCode = 'NET_TIMEOUT';
      httpStatus = 502;
    }

    log({
      event: 'request_error',
      url: targetUrl,
      start_ts: startTime,
      end_ts: endTime,
      timing_ms: timing,
      outcome: 'error',
      error_code: errorCode,
      error_message: error.message
    });

    throw { httpStatus, errorCode, message: error.message, timing };

  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        log({ event: 'page_close_error', error: e.message });
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        log({ event: 'browser_close_error', error: e.message });
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  
  if (pathname === '/status') {
    res.statusCode = 200;
    res.end(JSON.stringify({ 
      ok: true, 
      service: 'playwright-title-service',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  if (pathname === '/title' && req.method === 'GET') {
    const targetUrl = parsedUrl.query.url;
    
    const validation = validateUrl(targetUrl);
    if (!validation.valid) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        ok: false,
        error: validation.error
      }));
      return;
    }

    const requestTimeout = setTimeout(() => {
      if (!res.headersSent) {
        res.statusCode = 504;
        res.end(JSON.stringify({
          ok: false,
          error: `Request timed out after ${REQ_TIMEOUT_MS} ms`
        }));
      }
    }, REQ_TIMEOUT_MS);

    try {
      const result = await getPageTitle(targetUrl);
      clearTimeout(requestTimeout);
      
      if (!res.headersSent) {
        res.statusCode = 200;
        res.end(JSON.stringify(result));
      }
    } catch (error) {
      clearTimeout(requestTimeout);
      
      if (!res.headersSent) {
        res.statusCode = error.httpStatus || 500;
        res.end(JSON.stringify({
          ok: false,
          error: error.message || 'Internal server error'
        }));
      }
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({
    ok: false,
    error: 'Not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  log({
    event: 'server_start',
    port: PORT,
    host: '0.0.0.0',
    pid: process.pid,
    node_version: process.version,
    debug: DEBUG,
    env_port: process.env.PORT
  });
});

process.on('SIGTERM', () => {
  log({ event: 'sigterm_received' });
  server.close(() => {
    log({ event: 'server_shutdown' });
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log({ event: 'sigint_received' });
  server.close(() => {
    log({ event: 'server_shutdown' });
    process.exit(0);
  });
});