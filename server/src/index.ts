import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import fs from 'fs';
import https from 'https';
import http from 'http';

const PORT = process.env.PORT ?? 3001;

async function main() {
  initDb();
  const app = createApp();

  if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
    const options = {
      key: fs.readFileSync(process.env.SSL_KEY_PATH),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH)
    };
    https.createServer(options, app).listen(Number(PORT), '0.0.0.0', () => {
      console.log(`HTTPS Server running on https://0.0.0.0:${PORT}`);
      console.log(`Proxy endpoint: https://0.0.0.0:${PORT}/v1/chat/completions`);
      startHealthChecker();
    });
  } else {
    http.createServer(app).listen(Number(PORT), '0.0.0.0', () => {
      console.log(`HTTP Server running on http://0.0.0.0:${PORT}`);
      console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
      startHealthChecker();
    });
  }
}

main().catch(console.error);
