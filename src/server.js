import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_FILE = process.env.LPM_DATA_FILE || path.join(ROOT_DIR, 'data', 'registry.json');
const HOST = process.env.LPM_HOST || '127.0.0.1';
const PORT = Number(process.env.LPM_PORT || 17321);
const DEFAULT_PORT_START = 3000;
const DEFAULT_PORT_END = 9999;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/opensearchdescription+xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ services: [] }, null, 2));
  }
}

async function readRegistry() {
  await ensureDataFile();
  const content = await fs.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(content || '{"services":[]}');
  return { services: Array.isArray(parsed.services) ? parsed.services : [] };
}

async function writeRegistry(registry) {
  await ensureDataFile();
  await fs.writeFile(DATA_FILE, JSON.stringify(registry, null, 2));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, statusCode, message, details = undefined) {
  sendJson(res, statusCode, { error: { message, details } });
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeService(input, existing = {}) {
  const now = new Date().toISOString();
  const port = input.port === undefined ? existing.port : normalizePort(input.port);
  if (!input.name && !existing.name) {
    throw new Error('name is required');
  }
  if (!port) {
    throw new Error('valid port is required');
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : existing.tags || [];

  return {
    id: existing.id || crypto.randomUUID(),
    name: String(input.name ?? existing.name).trim(),
    path: String(input.path ?? existing.path ?? '').trim(),
    port,
    host: String(input.host ?? existing.host ?? '127.0.0.1').trim() || '127.0.0.1',
    protocol: ['http', 'https'].includes(input.protocol ?? existing.protocol) ? input.protocol ?? existing.protocol : 'http',
    status: ['running', 'stopped', 'reserved', 'unknown'].includes(input.status ?? existing.status)
      ? input.status ?? existing.status
      : 'unknown',
    tags,
    description: String(input.description ?? existing.description ?? '').trim(),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function serviceUrl(service) {
  return `${service.protocol}://${service.host}:${service.port}`;
}

async function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host, timeout: 350 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function getPortAvailability(port, ignoreServiceId = null) {
  const registry = await readRegistry();
  const registeredService = registry.services.find(
    (service) => service.port === port && service.id !== ignoreServiceId
  );
  const systemListening = await isPortListening(port);
  return {
    port,
    available: !registeredService && !systemListening,
    registered: Boolean(registeredService),
    listening: systemListening,
    service: registeredService || null
  };
}

function canSaveServiceForAvailability(service, availability) {
  if (availability.registered) return false;
  if (!availability.listening) return true;
  return service.status === 'running';
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function withUrl(req) {
  return new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
}

function listServices(services, searchParams) {
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  const tag = (searchParams.get('tag') || '').toLowerCase().trim();
  const status = (searchParams.get('status') || '').toLowerCase().trim();

  return services
    .filter((service) => {
      const qMatch = !q || [service.name, service.path, service.description, String(service.port)]
        .join(' ')
        .toLowerCase()
        .includes(q);
      const tagMatch = !tag || service.tags.some((item) => item.toLowerCase() === tag);
      const statusMatch = !status || service.status === status;
      return qMatch && tagMatch && statusMatch;
    })
    .map((service) => ({ ...service, url: serviceUrl(service) }))
    .sort((a, b) => a.port - b.port || a.name.localeCompare(b.name));
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, jsonHeaders);
    res.end();
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, name: 'Local Port Manager', port: PORT, dataFile: DATA_FILE });
    return;
  }

  if (url.pathname === '/api/services' && req.method === 'GET') {
    const registry = await readRegistry();
    sendJson(res, 200, { services: listServices(registry.services, url.searchParams) });
    return;
  }

  if (url.pathname === '/api/services' && req.method === 'POST') {
    const body = await parseBody(req);
    const service = normalizeService(body);
    const availability = await getPortAvailability(service.port);
    if (!canSaveServiceForAvailability(service, availability)) {
      sendJson(res, 409, { error: { message: 'port is not available' }, availability });
      return;
    }
    const registry = await readRegistry();
    registry.services.push(service);
    await writeRegistry(registry);
    sendJson(res, 201, { service: { ...service, url: serviceUrl(service) } });
    return;
  }

  const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)$/);
  if (serviceMatch && ['PATCH', 'DELETE'].includes(req.method)) {
    const id = decodeURIComponent(serviceMatch[1]);
    const registry = await readRegistry();
    const index = registry.services.findIndex((service) => service.id === id);
    if (index === -1) {
      sendError(res, 404, 'service not found');
      return;
    }

    if (req.method === 'DELETE') {
      const [removed] = registry.services.splice(index, 1);
      await writeRegistry(registry);
      sendJson(res, 200, { service: removed });
      return;
    }

    const body = await parseBody(req);
    const service = normalizeService(body, registry.services[index]);
    const availability = await getPortAvailability(service.port, service.id);
    if (!canSaveServiceForAvailability(service, availability)) {
      sendJson(res, 409, { error: { message: 'port is not available' }, availability });
      return;
    }
    registry.services[index] = service;
    await writeRegistry(registry);
    sendJson(res, 200, { service: { ...service, url: serviceUrl(service) } });
    return;
  }

  if (url.pathname === '/api/ports/check' && req.method === 'GET') {
    const port = normalizePort(url.searchParams.get('port'));
    if (!port) {
      sendError(res, 400, 'valid port query is required');
      return;
    }
    sendJson(res, 200, await getPortAvailability(port));
    return;
  }

  if (url.pathname === '/api/ports/suggest' && req.method === 'GET') {
    const start = normalizePort(url.searchParams.get('start')) || DEFAULT_PORT_START;
    const end = normalizePort(url.searchParams.get('end')) || DEFAULT_PORT_END;
    const count = Math.min(Number(url.searchParams.get('count')) || 1, 50);
    if (start > end) {
      sendError(res, 400, 'start must be less than or equal to end');
      return;
    }

    const suggestions = [];
    for (let port = start; port <= end && suggestions.length < count; port += 1) {
      const availability = await getPortAvailability(port);
      if (availability.available) suggestions.push(port);
    }
    sendJson(res, 200, { suggestions, start, end, count });
    return;
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const registry = await readRegistry();
    const services = registry.services;
    const tags = [...new Set(services.flatMap((service) => service.tags))].sort();
    const statusCounts = services.reduce((acc, service) => {
      acc[service.status] = (acc[service.status] || 0) + 1;
      return acc;
    }, {});
    sendJson(res, 200, {
      total: services.length,
      ports: services.map((service) => service.port).sort((a, b) => a - b),
      tags,
      statusCounts
    });
    return;
  }

  sendError(res, 404, 'api route not found');
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

async function requestHandler(req, res) {
  try {
    const url = withUrl(req);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error.statusCode || 500, error.message || 'internal server error');
  }
}

await ensureDataFile();

http.createServer(requestHandler).listen(PORT, HOST, () => {
  console.log(`Local Port Manager is running at http://${HOST}:${PORT}`);
});
