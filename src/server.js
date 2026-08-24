import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_FILE = process.env.LPM_DATA_FILE || path.join(ROOT_DIR, 'data', 'registry.json');
const HOST = process.env.LPM_HOST || '127.0.0.1';
const PORT = Number(process.env.LPM_PORT || 17321);
const DEFAULT_PORT_START = 3000;
const DEFAULT_PORT_END = 9999;
const LAUNCH_AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const NODE_BIN_DIR = path.dirname(process.execPath);
const DEFAULT_LAUNCHD_PATH = [
  NODE_BIN_DIR,
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(':');

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

function isLoopbackHost(value) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(value || '').trim().toLowerCase());
}

function normalizeKind(value) {
  return value === 'remote' ? 'remote' : 'local';
}

function parseRemoteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function inferServiceKind(input = {}, existing = {}) {
  const explicit = input.kind ?? existing.kind;
  if (explicit === 'local' || explicit === 'remote') {
    return explicit;
  }
  if (input.remoteUrl ?? existing.remoteUrl) {
    return 'remote';
  }

  const host = String(input.host ?? existing.host ?? '').trim();
  const pathValue = String(input.path ?? existing.path ?? '').trim();
  if (host && !isLoopbackHost(host) && /^https?:\/\//.test(pathValue)) {
    return 'remote';
  }
  return 'local';
}

function normalizeService(input, existing = {}) {
  const now = new Date().toISOString();
  const kind = inferServiceKind(input, existing);
  if (!input.name && !existing.name) {
    throw new Error('name is required');
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : existing.tags || [];

  const base = {
    id: existing.id || crypto.randomUUID(),
    kind,
    name: String(input.name ?? existing.name).trim(),
    path: String(input.path ?? existing.path ?? '').trim(),
    status: ['running', 'stopped', 'reserved', 'unknown'].includes(input.status ?? existing.status)
      ? input.status ?? existing.status
      : 'unknown',
    autostart: (input.autostart ?? existing.autostart) ?? false,
    startupCommand: String((input.startupCommand ?? existing.startupCommand) || '').trim(),
    tags,
    description: String(input.description ?? existing.description ?? '').trim(),
    comment: String(input.comment ?? existing.comment ?? '').trim(),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };

  if (kind === 'remote') {
    const remoteUrl = parseRemoteUrl(input.remoteUrl ?? existing.remoteUrl ?? serviceUrl(existing));
    if (!remoteUrl) {
      throw new Error('valid remoteUrl is required');
    }

    return {
      ...base,
      host: remoteUrl.hostname,
      port: normalizePort(remoteUrl.port) || (remoteUrl.protocol === 'https:' ? 443 : 80),
      protocol: remoteUrl.protocol.replace(':', ''),
      remoteUrl: remoteUrl.toString()
    };
  }

  const port = input.port === undefined ? existing.port : normalizePort(input.port);
  if (!port) {
    throw new Error('valid port is required');
  }

  return {
    ...base,
    port,
    host: String(input.host ?? existing.host ?? '127.0.0.1').trim() || '127.0.0.1',
    protocol: ['http', 'https'].includes(input.protocol ?? existing.protocol) ? input.protocol ?? existing.protocol : 'http',
    remoteUrl: ''
  };
}

async function ensureStartupCommand(service) {
  if (service.kind !== 'local' || !service.autostart || service.startupCommand) {
    return service;
  }

  const inferred = await inferStartupCommand(service);
  if (!inferred) {
    throw new Error('startupCommand is required to enable autostart');
  }
  return { ...service, startupCommand: inferred };
}

async function inferStartupCommand(service) {
  const projectPath = String(service.path || '').trim();
  if (!projectPath || !path.isAbsolute(projectPath)) return '';

  const packageJsonPath = path.join(projectPath, 'package.json');
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    const scripts = packageJson.scripts || {};
    const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
    if (scripts.start) {
      return `npm --prefix ${quoteShellArg(projectPath)} start`;
    }
    if (scripts.dev) {
      if (deps.next) {
        return `npm --prefix ${quoteShellArg(projectPath)} run dev -- --hostname 127.0.0.1 --port ${service.port}`;
      }
      if (deps.vite || deps['@vitejs/plugin-react']) {
        return `npm --prefix ${quoteShellArg(projectPath)} run dev -- --host 127.0.0.1 --port ${service.port}`;
      }
      if (deps.astro) {
        return `npm --prefix ${quoteShellArg(projectPath)} run dev -- --host 127.0.0.1 --port ${service.port}`;
      }
      return `PORT=${service.port} npm --prefix ${quoteShellArg(projectPath)} run dev`;
    }
  } catch {
    // Fall through to static directory inference.
  }

  try {
    const entries = await fs.readdir(projectPath);
    if (entries.some((entry) => entry.endsWith('.html') || entry === 'index.html')) {
      return `python3 -m http.server ${service.port} --bind 127.0.0.1 --directory ${quoteShellArg(projectPath)}`;
    }
  } catch {
    return '';
  }
  return '';
}

function quoteShellArg(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function serviceUrl(service) {
  if (service.kind === 'remote' && service.remoteUrl) {
    return service.remoteUrl;
  }
  return `${service.protocol}://${service.host}:${service.port}`;
}

function hydrateService(service) {
  const kind = inferServiceKind(service, service);
  const remoteUrl = kind === 'remote'
    ? parseRemoteUrl(service.remoteUrl || `${service.protocol || 'https'}://${service.host}:${service.port}`)
    : null;
  const protocol = kind === 'remote'
    ? (remoteUrl?.protocol.replace(':', '') || service.protocol || 'https')
    : (service.protocol || 'http');
  const host = kind === 'remote'
    ? (remoteUrl?.hostname || service.host || '')
    : (service.host || '127.0.0.1');
  const port = kind === 'remote'
    ? (normalizePort(remoteUrl?.port) || normalizePort(service.port) || (protocol === 'https' ? 443 : 80))
    : normalizePort(service.port);

  const hydrated = {
    ...service,
    kind,
    protocol,
    host,
    port,
    remoteUrl: kind === 'remote' ? (service.remoteUrl || remoteUrl?.toString() || '') : '',
    tags: Array.isArray(service.tags) ? service.tags : []
  };

  return { ...hydrated, url: serviceUrl(hydrated) };
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
  const registeredService = registry.services
    .map(hydrateService)
    .find(
      (service) => service.kind === 'local' && service.port === port && service.id !== ignoreServiceId
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
  if (service.kind === 'remote') return true;
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
  const kind = (searchParams.get('kind') || '').toLowerCase().trim();

  return services
    .map(hydrateService)
    .filter((service) => {
      const qMatch = !q || [service.name, service.path, service.description, service.comment, service.url, service.remoteUrl, String(service.port)]
        .join(' ')
        .toLowerCase()
        .includes(q);
      const tagMatch = !tag || service.tags.some((item) => item.toLowerCase() === tag);
      const statusMatch = !status || service.status === status;
      const kindMatch = !kind || service.kind === kind;
      return qMatch && tagMatch && statusMatch && kindMatch;
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
      if (a.kind === 'local') return a.port - b.port || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name) || a.url.localeCompare(b.url);
    });
}

async function getLocalProjectPath(service) {
  const hydrated = hydrateService(service);
  if (hydrated.kind !== 'local') {
    const error = new Error('only local services can open project paths');
    error.statusCode = 400;
    throw error;
  }

  const rawPath = String(hydrated.path || '').trim();
  if (!rawPath || !path.isAbsolute(rawPath)) {
    const error = new Error('service path must be an absolute local path');
    error.statusCode = 400;
    throw error;
  }

  const resolved = path.resolve(rawPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    const error = new Error('service path does not exist');
    error.statusCode = 404;
    throw error;
  }

  if (!stat.isDirectory()) {
    const error = new Error('service path must be a directory');
    error.statusCode = 400;
    throw error;
  }

  return resolved;
}

function openDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function openServiceProject(service, target) {
  const projectPath = await getLocalProjectPath(service);
  if (target === 'vscode') {
    openDetached('open', ['-a', 'Visual Studio Code', projectPath]);
    return { target, path: projectPath };
  }
  if (target === 'terminal') {
    openDetached('open', ['-a', 'Terminal', projectPath]);
    return { target, path: projectPath };
  }

  const error = new Error('target must be vscode or terminal');
  error.statusCode = 400;
  throw error;
}

function getLaunchdPlistPath(service) {
  const safeLabel = service.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  const label = `com.bytedance.lpm.${safeLabel}-${service.id.slice(0, 8)}`;
  return {
    label,
    plistPath: path.join(LAUNCH_AGENT_DIR, `${label}.plist`)
  };
}

function generateLaunchdPlist(service) {
  const { label } = getLaunchdPlistPath(service);
  const cmd = service.startupCommand || `npm start`;
  const workingDir = service.path;

  const { args, envVars } = parseStartupCommand(cmd);
  if (args.length === 0) {
    throw new Error('startupCommand must include an executable');
  }
  args[0] = resolveLaunchdExecutable(args[0]);
  envVars.PATH = envVars.PATH || DEFAULT_LAUNCHD_PATH;
  if (service.kind === 'local' && service.port && !envVars.PORT) {
    envVars.PORT = String(service.port);
  }

  // Generate environment XML entries
  const envEntries = Object.entries(envVars)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
${args.map(arg => `      <string>${escapeXml(arg)}</string>`).join('\n')}
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDir)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(os.homedir(), 'Library', 'Logs', `${label}.log`))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(os.homedir(), 'Library', 'Logs', `${label}.error.log`))}</string>
  </dict>
</plist>
`;
  return plist;
}

function parseStartupCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;
  for (const char of String(command || '')) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);

  const envVars = {};
  const args = [];
  let readingEnv = true;
  for (const token of tokens) {
    const envMatch = readingEnv && token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (envMatch) {
      envVars[envMatch[1]] = envMatch[2];
      continue;
    }
    readingEnv = false;
    args.push(token);
  }
  return { args, envVars };
}

function resolveLaunchdExecutable(executable) {
  if (path.isAbsolute(executable) || executable.includes('/')) {
    return executable;
  }
  if (executable === 'node') {
    return process.execPath;
  }
  if (['npm', 'npx', 'corepack'].includes(executable)) {
    return path.join(NODE_BIN_DIR, executable);
  }
  try {
    return execFileSync('/usr/bin/which', [executable], {
      encoding: 'utf8',
      env: { ...process.env, PATH: DEFAULT_LAUNCHD_PATH }
    }).trim() || executable;
  } catch {
    return executable;
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function updateAutostart(service) {
  await fs.mkdir(LAUNCH_AGENT_DIR, { recursive: true });
  const { plistPath } = getLaunchdPlistPath(service);

  if (service.autostart && service.kind === 'local') {
    if (!service.startupCommand) {
      throw new Error('startupCommand is required to enable autostart');
    }
    const plistContent = generateLaunchdPlist(service);
    await fs.writeFile(plistPath, plistContent);
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    } catch {
      // It may not be loaded yet.
    }
    execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
  } else {
    try {
      await fs.access(plistPath);
      try {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      } catch {
        // It may already be unloaded.
      }
      await fs.unlink(plistPath);
    } catch {
      // File does not exist.
    }
  }
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
    let service = normalizeService(body);
    service = await ensureStartupCommand(service);
    const availability = await getPortAvailability(service.port);
    if (!canSaveServiceForAvailability(service, availability)) {
      sendJson(res, 409, { error: { message: 'port is not available' }, availability });
      return;
    }
    const registry = await readRegistry();
    registry.services.push(service);
    if (service.kind === 'local') {
      try {
        await updateAutostart(service);
      } catch (error) {
        sendError(res, 400, error.message);
        return;
      }
    }
    await writeRegistry(registry);
    sendJson(res, 201, { service: hydrateService(service) });
    return;
  }

  const openMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/open$/);
  if (openMatch && req.method === 'POST') {
    const id = decodeURIComponent(openMatch[1]);
    const body = await parseBody(req);
    const registry = await readRegistry();
    const service = registry.services.find((item) => item.id === id);
    if (!service) {
      sendError(res, 404, 'service not found');
      return;
    }

    const result = await openServiceProject(service, body.target);
    sendJson(res, 200, { ok: true, ...result });
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
      // Remove launchd plist if it exists
      if (removed.kind === 'local') {
        removed.autostart = false;
        await updateAutostart(removed);
      }
      await writeRegistry(registry);
      sendJson(res, 200, { service: removed });
      return;
    }

    const body = await parseBody(req);
    let service = normalizeService(body, registry.services[index]);
    service = await ensureStartupCommand(service);
    const availability = await getPortAvailability(service.port, service.id);
    if (!canSaveServiceForAvailability(service, availability)) {
      sendJson(res, 409, { error: { message: 'port is not available' }, availability });
      return;
    }
    if (service.kind === 'local') {
      try {
        await updateAutostart(service);
      } catch (error) {
        sendError(res, 400, error.message);
        return;
      }
    }
    registry.services[index] = service;
    await writeRegistry(registry);
    sendJson(res, 200, { service: hydrateService(service) });
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
    const hydrated = services.map(hydrateService);
    sendJson(res, 200, {
      total: services.length,
      localTotal: hydrated.filter((service) => service.kind === 'local').length,
      remoteTotal: hydrated.filter((service) => service.kind === 'remote').length,
      ports: hydrated.filter((service) => service.kind === 'local').map((service) => service.port).sort((a, b) => a - b),
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
