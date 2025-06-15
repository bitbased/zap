#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ANSI_RESET = '\u001b[0m';
const ANSI_BOLD = '\u001b[1m';
const ANSI_RED = '\u001b[31m';
const ANSI_GREEN = '\u001b[32m';
const ANSI_YELLOW = '\u001b[33m';
const ANSI_GRAY = '\u001b[90m';

const useColor = process.stdout.isTTY;
function color(text, code) { return useColor ? code + text + ANSI_RESET : text; }
function bold(text) { return color(text, ANSI_BOLD); }
function red(text) { return color(text, ANSI_RED); }
function green(text) { return color(text, ANSI_GREEN); }
function yellow(text) { return color(text, ANSI_YELLOW); }
function gray(text) { return color(text, ANSI_GRAY); }

(function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/);
    if (!match) continue;
    let key = match[1];
    let val = match[2] || '';
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
})();

function findConfigDir(startDir) {
  let dir = startDir;
  while (true) {
    const cfgPath = path.join(dir, 'zapconfig.json');
    if (fs.existsSync(cfgPath)) return dir;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && typeof pkg.zap === 'object') return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadConfig() {
  const cwd = process.cwd();
  let pkgConfig = {};
  let fileConfig = {};
  let configDir = cwd;

  try {
    const pkgPath = path.join(configDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg.zap === 'object') pkgConfig = pkg.zap;
    }
  } catch {}

  try {
    const cfgPath = process.env.ZAP_CONFIG || path.join(configDir, 'zapconfig.json');
    if (fs.existsSync(cfgPath)) fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}

  if (!Object.keys(pkgConfig).length && !Object.keys(fileConfig).length) {
    const up = findConfigDir(cwd);
    if (up) {
      configDir = up;
      try {
        const pkgPath = path.join(configDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg && typeof pkg.zap === 'object') pkgConfig = pkg.zap;
        }
      } catch {}
      try {
        const cfgPath = process.env.ZAP_CONFIG || path.join(configDir, 'zapconfig.json');
        if (fs.existsSync(cfgPath)) fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch {}
    }
  }

  const ignoreList = [];
  if (Array.isArray(pkgConfig.ignore)) ignoreList.push(...pkgConfig.ignore);
  if (Array.isArray(fileConfig.ignore)) ignoreList.push(...fileConfig.ignore);

  const combined = { ...pkgConfig, ...fileConfig };
  if (ignoreList.length) combined.ignore = ignoreList;
  combined.configDir = configDir;
  return combined;
}

/**
 * Expand ignore patterns, supporting "file:<path>" entries.
 * @param {string[]} patterns
 * @param {string} root
 * @returns {string[]}
 */
function expandIgnores(patterns, root) {
  const out = [];
  for (const pat of patterns) {
    if (typeof pat === 'string' && pat.startsWith('file:')) {
      const filePath = pat.slice('file:'.length);
      const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
      if (fs.existsSync(abs)) {
        const content = fs.readFileSync(abs, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          out.push(trimmed);
        }
      }
    } else {
      out.push(pat);
    }
  }
  return out;
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = (opts.protocol === 'https:' ? https : http).request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ res, body: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function printHelp() {
  const raw = `
Usage: zap [options] <command> [args...] [-- [options]]

Options:
  --host <[ssh://][token@|user:pass@]host[:port]>  target zap-host address or SSH host (prefix with token@ for API token or user:pass@ for login)
  --user <username>         authentication username (defaults to config and overridden by user:pass@)
  --key <token>             API token for authentication (defaults to config or token@host prefix)
  --config <path>           path to zapconfig.json (env ZAP_CONFIG or default ./zapconfig.json)
  --path <remotePath>       override remote sync path (fallback to env ZAP_PATH, config.path, or directory name)
  --ignore <pattern>        add ignore pattern (like .zapignore entries; repeatable; supports file:<path> to load patterns from file)
  push, --push             push (sync once) current directory before running command (also enabled by config.push/config.sync or env ZAP_PUSH/ZAP_SYNC)
  --nopush                 disable automatic push (overrides config.push/config.sync, --push, and env ZAP_PUSH/ZAP_SYNC)
  --sync                   alias for sync command (continuously sync current directory before running command; also enabled by config.sync or env ZAP_SYNC)
  --nosync                 disable continuous sync (overrides config.sync, --sync, and env ZAP_SYNC)
  watch, --watch             restart service on sync events (respecting .zapignore, config.ignore, and --ignore; also enabled by config.watch or env ZAP_WATCH)
  --nowatch                 disable service restart on sync events (overrides config.watch, --watch, and env ZAP_WATCH)
  ssh, --ssh                force SSH mode (treat host as SSH target or via zapconfig.json ssh=true)
  --exec <cmd>              run the given command string as a service and poll logs until exit
  --name <name>             assign or reuse a persistent service name for exec/run
  --debug                   print debug info (config paths, flags, command, ignores)
  --noenv                   disable reading of environment variables (use only config & flags)
  --help                    show this help message

Commands:
  sync [push] [nopush] [watch] [nowatch] [<command> [args...]]  continuously sync current directory to remote (respecting .zapignore, config.ignore, and --ignore);
    with push, do one-off initial sync and exit; with nopush, skip initial sync;
    with watch, restart service on changes; with nowatch, skip service restarts;
    with a subcommand, sync before running it
  package <dir> [out]       create a tar.gz archive of directory (respecting .zapignore, config.ignore, and --ignore)
  exec <command> [args...]  start an arbitrary shell command as a service and poll logs until exit
  run <script> [args...]    alias for exec npm run <script> [args...]
  list                      list services
  get <id>                  get service info
  create [opts]             create service (use --cmd, --auto-restart, --restart-delay, --idle-timeout, --path; fallback to global --path, env ZAP_PATH, config.path, or directory name)
  update <id> [opts]        update service configuration (--cmd <cmd>, --auto-restart, --restart-delay <sec>, --idle-timeout <sec>, --path <path>)
  start <id>                start a stopped service
  stop <id>                 stop a running service
  delete <id>               delete a service
  logs <id> [opts]          fetch service logs (--since, --until, --limit)
  clear-logs <id>           clear service logs
`;
  const colored = raw.split('\n').map(line => {
    if (/^(Usage:|Options:|Commands:)/.test(line)) {
      return yellow(line);
    }
    const m = line.match(/^(\s*)(\S.*?\S)(\s{2,})(.*)$/);
    if (m) {
      const [, indent, cmdPart, sep, desc] = m;
      const [cmdName, ...cmdArgs] = cmdPart.split(/\s+/);
      return indent
        + green(cmdName)
        + (cmdArgs.length ? ' ' + yellow(cmdArgs.join(' ')) : '')
        + sep
        + gray(desc);
    }
    if (/^\s+/.test(line) && line.trim()) {
      return gray(line);
    }
    return line;
  }).join('\n');
  console.log(colored);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  function shellQuote(s) {
    if (/^[A-Za-z0-9_\/:=-]+$/.test(s)) {
      return s;
    }
    const escaped = s.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }

  const sentinelIndex = rawArgs.indexOf('--');
  const preParts = sentinelIndex >= 0 ? rawArgs.slice(0, sentinelIndex) : rawArgs;
  const postParts = sentinelIndex >= 0 ? rawArgs.slice(sentinelIndex + 1) : [];

  let sshFlag = false;
  let hostFlag;
  let usernameFlag;
  let keyFlag;
  let configFlag;
  let pathFlag;
  let nameFlag;
  let debugFlag = false;
  let noEnvFlag = false;
  let execFlag = false;
  let execCmd = null;
  let syncFlag = false;
  let noSyncFlag = false;
  let pushFlag = false;
  let noPushFlag = false;
  let watchFlag = false;
  let noWatchFlag = false;
  let cmdArgs = [];
  let ignoreFlags = [];
  let serviceId;

  for (let i = 0; i < preParts.length; i++) {
    const a = preParts[i];
    if (a === '--host' && preParts[i + 1]) {
      hostFlag = preParts[++i];
    } else if (a === '--user' && preParts[i + 1]) {
      usernameFlag = preParts[++i];
    } else if (a === '--key' && preParts[i + 1]) {
      keyFlag = preParts[++i];
    } else if (a === '--config' && preParts[i + 1]) {
      configFlag = preParts[++i];
    } else if (a === '--path' && preParts[i + 1]) {
      pathFlag = preParts[++i];
    } else if (a === '--name' && preParts[i + 1]) {
      nameFlag = preParts[++i];
    } else if (a === '--debug') {
      debugFlag = true;
    } else if (a === '--noenv') {
      noEnvFlag = true;
    } else if (a === '--ignore' && preParts[i + 1]) {
      ignoreFlags.push(preParts[++i]);
    } else if (a === '--exec' && preParts[i + 1]) {
      execFlag = true;
      execCmd = preParts[++i];
    } else if (a === 'push' || a === '--push') {
      pushFlag = true;
    } else if (a === 'nopush' || a === '--nopush') {
      noPushFlag = true;
    } else if (a === 'watch' || a === '--watch') {
      watchFlag = true;
    } else if (a === 'nowatch' || a === '--nowatch') {
      noWatchFlag = true;
    } else if (a === 'ssh' || a === '--ssh') {
      sshFlag = true;
    } else if (a === '--sync') {
      syncFlag = true;
    } else if (a === '--nosync') {
      noSyncFlag = true;
    } else if (a.startsWith('--')) {
    } else {
      cmdArgs = preParts.slice(i);
      break;
    }
  }
  for (let i = 0; i < postParts.length; i++) {
    const a = postParts[i];
    if (a === '--host' && postParts[i + 1]) {
      hostFlag = postParts[++i];
    } else if (a === '--user' && postParts[i + 1]) {
      usernameFlag = postParts[++i];
    } else if (a === '--key' && postParts[i + 1]) {
      keyFlag = postParts[++i];
    } else if (a === '--config' && postParts[i + 1]) {
      configFlag = postParts[++i];
    } else if (a === '--path' && postParts[i + 1]) {
      pathFlag = postParts[++i];
    } else if (a === '--ignore' && postParts[i + 1]) {
      ignoreFlags.push(postParts[++i]);
    } else if (a === '--exec' && postParts[i + 1]) {
      execFlag = true;
      execCmd = postParts[++i];
    } else if (a === 'push' || a === '--push') {
      pushFlag = true;
    } else if (a === 'nopush' || a === '--nopush') {
      noPushFlag = true;
    } else if (a === 'watch' || a === '--watch') {
      watchFlag = true;
    } else if (a === 'nowatch' || a === '--nowatch') {
      noWatchFlag = true;
    } else if (a === '--sync') {
      syncFlag = true;
    } else if (a === '--nosync') {
      noSyncFlag = true;
    } else if (a.startsWith('--')) {
    } else {
      break;
    }
  }

  if (configFlag) process.env.ZAP_CONFIG = configFlag;
  const config = loadConfig();
  const envIgnorePatterns = process.env.ZAP_IGNORE
    ? process.env.ZAP_IGNORE.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // resolve host/user/key taking --noenv and --config into account
  let host;
  if (hostFlag) host = hostFlag;
  else if (configFlag) host = config.host || (noEnvFlag ? '' : process.env.ZAP_HOST) || '';
  else host = (noEnvFlag ? '' : process.env.ZAP_HOST) || config.host || '';
  let username;
  if (usernameFlag) username = usernameFlag;
  else if (configFlag) username = config.username || (noEnvFlag ? undefined : process.env.ZAP_USERNAME);
  else username = (noEnvFlag ? undefined : process.env.ZAP_USERNAME) || config.username;
  let password;
  if (configFlag) password = config.password || (noEnvFlag ? undefined : process.env.ZAP_PASSWORD);
  else password = (noEnvFlag ? undefined : process.env.ZAP_PASSWORD) || config.password;
  let key;
  if (keyFlag) key = keyFlag;
  else if (configFlag) key = config.key || (noEnvFlag ? undefined : (process.env.ZAP_TOKEN || process.env.ZAP_KEY));
  else key = (noEnvFlag ? undefined : (process.env.ZAP_TOKEN || process.env.ZAP_KEY)) || config.key;

  if (!host) {
    console.error('Error: host is required (--host or config.host)');
    process.exit(1);
  }
  const isSSH = sshFlag || host.startsWith('ssh://') || config.ssh;
  let sshHost, sshPort, sshUser;
  if (isSSH) {
    const uri = host.startsWith('ssh://') ? host : `ssh://${host}`;
    const u = new URL(uri);
    sshHost = u.hostname;
    sshPort = u.port;
    sshUser = u.username || undefined;
  }
  if (!isSSH && host.includes('@')) {
    const [prefix, h] = host.split('@', 2);
    host = h;
    if (prefix.includes(':')) {
      const [u, p] = prefix.split(':', 2);
      username = u;
      password = p;
    } else {
      key = prefix;
    }
  }
  if (!isSSH && !key && !(username && password)) {
    console.error(
      'Error: authentication required: prefix host with token@ or user:pass@, or set key/password in config or via flags'
    );
    process.exit(1);
  }

  if (cmdArgs[0] === 'sync') {
    syncFlag = true;
    cmdArgs.shift();
    while (
      cmdArgs[0] === 'watch' || cmdArgs[0] === '--watch' ||
      cmdArgs[0] === 'push' || cmdArgs[0] === '--push' ||
      cmdArgs[0] === 'nopush' || cmdArgs[0] === '--nopush'
    ) {
      const a = cmdArgs.shift();
      if (a === 'watch' || a === '--watch') {
        watchFlag = true;
      } else if (a === 'push' || a === '--push') {
        pushFlag = true;
      } else if (a === 'nopush' || a === '--nopush') {
        noPushFlag = true;
      }
    }
  }
  let envSync, envPush, envWatch;
  if (!noEnvFlag) {
    if (process.env.ZAP_SYNC !== undefined) {
      envSync = process.env.ZAP_SYNC === 'true';
    }
    if (process.env.ZAP_PUSH !== undefined) {
      envPush = process.env.ZAP_PUSH === 'true';
    }
    if (process.env.ZAP_WATCH !== undefined) {
      envWatch = process.env.ZAP_WATCH === 'true';
    }
  }
  if (noSyncFlag) {
    syncFlag = false;
  } else if (envSync !== undefined) {
    syncFlag = envSync;
  }
  if (noPushFlag || noSyncFlag) {
    pushFlag = false;
  } else if (envPush !== undefined) {
    pushFlag = envPush;
  } else if (envSync !== undefined ? envSync : (config.push || config.sync)) {
    pushFlag = true;
  }
  if (noWatchFlag) {
    watchFlag = false;
  } else if (envWatch !== undefined) {
    watchFlag = envWatch;
  } else if (config.watch) {
    watchFlag = true;
  }
  let [cmd, ...args] = cmdArgs;
  let isRun = false;
  if (execFlag) {
    cmd = 'exec';
    args = [execCmd];
  } else if (cmd === 'run') {
    isRun = true;
    cmd = 'exec';
    args = ['npm', 'run', ...args];
  }
  if (!cmd) {
    console.error(red('Error: command is required'));
    printHelp();
    process.exit(1);
  }
  if (debugFlag) {
    console.error(bold('--- DEBUG INFO ---'));
    console.error(green('rawArgs:'), JSON.stringify(rawArgs));
    console.error(green('flags:'), JSON.stringify({ hostFlag, usernameFlag, keyFlag, configFlag, pathFlag, nameFlag, debugFlag, noEnvFlag, execFlag, syncFlag, noSyncFlag, pushFlag, noPushFlag, watchFlag, noWatchFlag, ignoreFlags, cmdArgs }, null, 2));
    console.error(green('command:'), cmd, args);
    console.error(green('configDir:'), config.configDir);
    console.error(green('config:'), JSON.stringify(config, null, 2));
    const pkgPath = path.join(config.configDir, 'package.json');
    const zapCfgPath = process.env.ZAP_CONFIG || path.join(config.configDir, 'zapconfig.json');
    console.error(green('package.json path:'), fs.existsSync(pkgPath) ? pkgPath : '<none>');
    console.error(green('zapconfig.json path:'), fs.existsSync(zapCfgPath) ? zapCfgPath : '<none>');
    console.error(green('ignore patterns from config:'), JSON.stringify(Array.isArray(config.ignore) ? config.ignore : [], null, 2));
    console.error(green('ignore patterns from env:'), JSON.stringify(envIgnorePatterns, null, 2));
    console.error(green('ignore patterns from flags:'), JSON.stringify(ignoreFlags, null, 2));
    const origins = {
      host: hostFlag ? 'flag' : (process.env.ZAP_HOST ? 'env' : (config.host ? 'config' : 'default')),
      username: usernameFlag ? 'flag' : (process.env.ZAP_USERNAME ? 'env' : (config.username ? 'config' : 'undefined')),
      key: keyFlag ? 'flag' : ((process.env.ZAP_TOKEN || process.env.ZAP_KEY) ? 'env' : (config.key ? 'config' : 'undefined')),
      path: pathFlag ? 'flag' : (process.env.ZAP_PATH ? 'env' : (config.path ? 'config' : 'default')),
      name: nameFlag ? 'flag' : 'none'
    };
    console.error(green('value origins:'), JSON.stringify(origins, null, 2));
  }

  let baseUrl;
  if (!isSSH) {
    const base = host.startsWith('http://') || host.startsWith('https://')
      ? host
      : `http://${host}`;
    baseUrl = new URL(base);
  }

  let token = null;
  if (!isSSH) {
    if (username && password) {
      try {
        const loginPayload = JSON.stringify({ username, password });
        const { res: loginRes, body: loginBody } = await request(
          {
            protocol: baseUrl.protocol,
            hostname: baseUrl.hostname,
            port: baseUrl.port,
            path: '/api/v0/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          },
          loginPayload
        );
        if (loginRes.statusCode !== 200) {
          console.error('Login failed:', loginBody);
          process.exit(1);
        }
        token = JSON.parse(loginBody).token;
      } catch (err) {
        console.error('Login error:', err.message);
        process.exit(1);
      }
    } else if (key) {
      try {
        const tokenPayload = JSON.stringify({ token: key });
        const { res: tokenRes, body: tokenBody } = await request(
          {
            protocol: baseUrl.protocol,
            hostname: baseUrl.hostname,
            port: baseUrl.port,
            path: '/api/v0/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          },
          tokenPayload
        );
        if (tokenRes.statusCode !== 200) {
          console.error('Token auth failed:', tokenBody);
          process.exit(1);
        }
        token = JSON.parse(tokenBody).token;
      } catch (err) {
        console.error('Token auth error:', err.message);
        process.exit(1);
      }
    }
  }

  async function api(method, p, bodyObj, query) {
    const path = p + (query ? `?${query}` : '');
    const opts = {
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    return await request(opts, body);
  }

  async function doSyncOnce() {
    const cwd = process.cwd();
    const root = config.configDir || cwd;
    // determine remote path with respect to --noenv and --config
    let dest;
    if (pathFlag) dest = pathFlag;
    else if (configFlag) dest = config.path || (noEnvFlag ? undefined : process.env.ZAP_PATH) || path.basename(root);
    else dest = (noEnvFlag ? undefined : process.env.ZAP_PATH) || config.path || path.basename(root);
    const rawIgnores = [
      ...(Array.isArray(config.ignore) ? config.ignore : []),
      ...envIgnorePatterns,
      ...ignoreFlags
    ];
    const excludes = expandIgnores(rawIgnores, root);
    if (isSSH) {
      const tarArgs = ['-cz'];
      const ignoreFile = path.join(root, '.zapignore');
      if (fs.existsSync(ignoreFile)) {
        tarArgs.push(`--exclude-from=${ignoreFile}`);
      }
      for (const pat of excludes) {
        tarArgs.push(`--exclude=${pat}`);
      }
      tarArgs.push('-C', cwd, '.');
      const tar = require('child_process').spawn('tar', tarArgs);
      const sshArgs = [];
      if (sshPort) sshArgs.push('-p', sshPort);
      sshArgs.push(sshUser ? `${sshUser}@${sshHost}` : sshHost);
      // Extract via tar, silencing unknown-header warnings on GNU tar
      const remoteCmd = `mkdir -p ${shellQuote(dest)} && tar --warning=no-unknown-keyword -xz -C ${shellQuote(dest)}`;
      sshArgs.push(remoteCmd);
      const ssh = require('child_process').spawn('ssh', sshArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
      if (!ssh) {
        throw new Error('Failed to spawn SSH process');
      }
      tar.stdout.pipe(ssh.stdin);
      tar.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        ssh.on('error', (err) => reject(new Error(`SSH error: ${err.message}`)));
        ssh.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`SSH sync failed: ${code}`))));
      });
    } else {
      const tarArgs = ['-cz'];
      const ignoreFile = path.join(root, '.zapignore');
      if (fs.existsSync(ignoreFile)) {
        tarArgs.push(`--exclude-from=${ignoreFile}`);
      }
      for (const pat of excludes) {
        tarArgs.push(`--exclude=${pat}`);
      }
      tarArgs.push('-C', cwd, '.');
      const tar = require('child_process').spawn('tar', tarArgs);
      let syncPath = '/api/v0/sync';
      if (dest) syncPath += `?path=${encodeURIComponent(dest)}`;
      const reqOpts = {
        protocol: baseUrl.protocol,
        hostname: baseUrl.hostname,
        port: baseUrl.port,
        path: syncPath,
        method: 'POST',
        headers: {}
      };
      if (token) reqOpts.headers.Authorization = `Bearer ${token}`;
      await new Promise((resolve, reject) => {
      const req = (baseUrl.protocol === 'https:' ? https : http).request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            if (line) process.stdout.write(yellow('[zap] ' + line) + '\n');
          }
        });
        res.on('end', () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Sync failed: ${res.statusCode}`));
        });
      });
        req.on('error', reject);
        tar.stdout.pipe(req);
        tar.stderr.pipe(process.stderr);
      });
    }
  }

  function startWatch(onChange) {
    const cwd = process.cwd();
    const root = config.configDir || cwd;
    const rawIgnores = [
      ...(Array.isArray(config.ignore) ? config.ignore : []),
      ...envIgnorePatterns,
      ...ignoreFlags
    ];
    const excludes = expandIgnores(rawIgnores, root);
    const ignoreFile = path.join(root, '.zapignore');
    let fileIgnores = [];
    if (fs.existsSync(ignoreFile)) {
      fileIgnores = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    }
    const patterns = [...excludes, ...fileIgnores];
    console.log(yellow('[zap] ' + `Watching for changes in ${root}...`));
    const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = path.relative(root, filename);
      if (patterns.some(p => rel.includes(p))) return;
      (async () => {
        try {
          console.log(`\nChange detected: ${rel}`);
          await doSyncOnce();
          if (onChange) await onChange();
        } catch (err) {
          console.error('Error during sync:', err.message);
        }
      })();
    });
    watcher.on('error', (err) => console.error('Watcher error:', err.message));
  }

  try {
    if ((pushFlag || syncFlag) && cmd !== 'sync') {
      await doSyncOnce();
      console.log();
    }
    // allow direct service commands without the 'services' prefix (e.g. zap stop <id>)
    {
      const serviceSubs = ['get','create','update','start','stop','delete','logs','clear-logs'];
      if (cmd === 'list' || serviceSubs.includes(cmd)) {
        args = [cmd, ...args];
        cmd = 'services';
      }
    }
    switch (cmd) {
      case 'sync': {
        if (pushFlag) {
          await doSyncOnce();
          break;
        }
        await doSyncOnce();
        startWatch();
        break;
      }


      case 'package': {
        const dir = args[0] || process.cwd();
        const outFile = args[1] || `${path.basename(dir)}.tar.gz`;
        const tarArgs = ['-cz'];
        const ignoreFile = path.join(config.configDir, '.zapignore');
        if (fs.existsSync(ignoreFile)) {
          tarArgs.push(`--exclude-from=${ignoreFile}`);
        }
        const rawIgnores = [...(Array.isArray(config.ignore) ? config.ignore : []), ...ignoreFlags];
        for (const pattern of expandIgnores(rawIgnores, config.configDir)) {
          tarArgs.push(`--exclude=${pattern}`);
        }
        tarArgs.push('-C', dir, '.');
        const tar = require('child_process').spawn('tar', tarArgs);
        const out = fs.createWriteStream(outFile);
        tar.stdout.pipe(out);
        tar.stderr.pipe(process.stderr);
        tar.on('close', (code) => {
          process.exit(code === 0 ? 0 : 1);
        });
        break;
      }
      case 'exec': {
        if (isSSH) {
          if (args.length === 0) {
            console.error('Usage: zap exec <command>');
            process.exit(1);
          }
          let cmdToRun;
          if (execFlag) {
            cmdToRun = args.join(' ');
          } else {
            cmdToRun = args.map(shellQuote).join(' ');
          }
          if (pushFlag && isRun) {
            const npmCheck = 'npm ci --dry-run > /dev/null 2>&1 || (echo "Running npm install..." && npm install)';
            cmdToRun = npmCheck + ' && ' + cmdToRun;
          }
          const cwd = process.cwd();
          const root = config.configDir || cwd;
          // determine remote path respecting --noenv and --config
          let dest;
          if (pathFlag) dest = pathFlag;
          else if (configFlag) dest = config.path || (noEnvFlag ? undefined : process.env.ZAP_PATH) || path.basename(root);
          else dest = (noEnvFlag ? undefined : process.env.ZAP_PATH) || config.path || path.basename(root);
          const remoteCmd = `cd ${shellQuote(dest)} && ${cmdToRun}`;
          const sshArgs = [];
          if (sshPort) sshArgs.push('-p', sshPort);
          sshArgs.push(sshUser ? `${sshUser}@${sshHost}` : sshHost);
          sshArgs.push(remoteCmd);
          const ssh = require('child_process').spawn('ssh', sshArgs, { stdio: 'inherit' });
          if (!ssh) {
            console.error('Error: Failed to spawn SSH process');
            process.exit(1);
          }
          ssh.on('error', (err) => {
            console.error('SSH error:', err.message);
            process.exit(1);
          });
          ssh.on('exit', (code) => process.exit(code || 0));
          break;
        }
        {
          let cmdToRun;
          if (execFlag) {
            cmdToRun = args.join(' ');
          } else {
            cmdToRun = args.map(shellQuote).join(' ');
          }
          if (pushFlag && isRun) {
            const npmCheck = 'npm ci --dry-run > /dev/null 2>&1 || (echo "Running npm install..." && npm install)';
            cmdToRun = npmCheck + ' && ' + cmdToRun;
          }
          const cwd = process.cwd();
          const root = config.configDir || cwd;
          const dest = pathFlag || process.env.ZAP_PATH || config.path || path.basename(root);
          const payload = { cmd: cmdToRun, autoRestart: false, restartDelay: 0, idleTimeout: 2, path: dest, ephemeral: true };
          if (nameFlag) payload.name = nameFlag;
          const { res: createRes, body: createBody } = await api('POST', '/api/v0/services', payload);
          if (createRes.statusCode < 200 || createRes.statusCode >= 300) {
            console.error(red('Error creating service:'), createBody);
            process.exit(1);
          }
          serviceId = JSON.parse(createBody).id;
        }
        if (syncFlag && !isSSH) {
          if (watchFlag) {
            startWatch(async () => {
              await api('POST', `/api/v0/services/${serviceId}/stop`).catch(() => {});
              await api('POST', `/api/v0/services/${serviceId}/start`).catch(() => {});
              console.log('Service restarted');
            });
          } else {
            startWatch();
          }
        }
        let aborted = false;
        const stopRemote = () => {
          if (aborted) return;
          aborted = true;
          api('POST', `/api/v0/services/${serviceId}/stop`)
            .catch(() => {})
            .then(() => process.exit(130));
        };
        process.on('SIGINT', stopRemote);
        process.on('SIGTERM', stopRemote);

        // forward local stdin lines to service stdin
        if (process.stdin.isTTY) {
          const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
          rl.on('line', async (line) => {
            if (line === 'detach') {
              // user typed detach: disable idle timeout so the service stays alive, then exit client
              try { await api('PUT', `/api/v0/services/${serviceId}`, { idleTimeout: 0 }); } catch {}
              process.exit(0);
            }
            try {
              await api('POST', `/api/v0/services/${serviceId}/send`, { input: line });
            } catch (err) {
              console.error('Error sending input to service:', err.message);
            }
          });
          rl.on('SIGINT', async () => {
            // user pressed Ctrl+C: stop the service and exit
            try { await api('POST', `/api/v0/services/${serviceId}/stop`); } catch {}
            process.exit(0);
          });
          rl.on('close', async () => {
            // user pressed Ctrl+D: detach and disable idle timeout
            try { await api('PUT', `/api/v0/services/${serviceId}`, { idleTimeout: 0 }); } catch {}
            process.exit(0);
          });
        }

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let lastTimestamp = 0;
        while (true) {
          const query = `since=${lastTimestamp}`;
          const { res: logRes, body: logBody } = await api('GET', `/api/v0/services/${serviceId}/logs`, null, query);
          if (logRes.statusCode !== 200) {
            console.error('Error fetching logs:', logBody);
            process.exit(1);
          }
          const entries = JSON.parse(logBody);
          for (const entry of entries) {
            console.log(entry.line);
            if (entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
          }
          const { res: statusRes, body: statusBody } = await api('GET', `/api/v0/services/${serviceId}`);
          if (statusRes.statusCode !== 200) {
            console.error('Error fetching status:', statusBody);
            process.exit(1);
          }
          const info = JSON.parse(statusBody);
          if (info.status !== 'running') {
            if (info.exitCode != null) process.exit(info.exitCode);
            break;
          }
          await sleep(250);
        }
        break;
      }

      case 'services': {
        if (isSSH) {
          console.error('Services commands are not supported over SSH');
          process.exit(1);
        }
        const sub = args[0];
        if (!sub || sub === 'list') {
          const { res, body } = await api('GET', '/api/v0/services');
          if (res.statusCode !== 200) {
            console.error(red('Error listing services:'), body);
            process.exit(1);
          }
          let services;
          try {
            services = JSON.parse(body);
          } catch {
            console.error(red('Invalid service list format.'));
            process.exit(1);
          }
          if (!Array.isArray(services) || services.length === 0) {
            console.log(gray('No services.'));
            break;
          }
          const headers = ['ID', 'Path', 'Cmd', 'Auto', 'Delay', 'Status', 'PID', 'Exit'];
          const rows = services.map(s => [
            s.id,
            s.path || '',
            s.cmd,
            s.autoRestart ? 'yes' : 'no',
            String(s.restartDelay),
            s.status,
            s.pid ? String(s.pid) : '',
            s.exitCode != null ? String(s.exitCode) : ''
          ]);
          const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
          console.log(headers.map((h, i) => bold(h.padEnd(colWidths[i]))).join('  '));
          rows.forEach(cells => {
            console.log(cells.map((c, i) => {
              if (i === 5) {
                const fn = c === 'running' ? green : c === 'exited' ? yellow : red;
                return fn(c.padEnd(colWidths[i]));
              }
              return c.padEnd(colWidths[i]);
            }).join('  '));
          });
          break;
        }
        switch (sub) {
          case 'get': {
            const id = args[1];
            if (!id) {
              console.error('Usage: zap get <id>');
              process.exit(1);
            }
            const { res, body } = await api('GET', `/api/v0/services/${id}`);
            if (res.statusCode !== 200) {
              console.error('Error:', body);
              process.exit(1);
            }
            console.log(body);
            break;
          }
          case 'create': {
            let cmdValue;
            let autoRestart = false;
            let restartDelay = 0;
            let idleTimeout = 0;
            let pathValue;
            for (let i = 1; i < args.length; i++) {
              if (args[i] === '--cmd' && args[i+1]) cmdValue = args[++i];
              else if (args[i] === '--auto-restart') autoRestart = true;
              else if (args[i] === '--restart-delay' && args[i+1]) restartDelay = parseInt(args[++i], 10);
              else if (args[i] === '--idle-timeout' && args[i+1]) idleTimeout = parseInt(args[++i], 10);
              else if (args[i] === '--path' && args[i+1]) pathValue = args[++i];
            }
            // default to configured path or fallback to global flag, env, or directory name
            const dir = process.cwd();
            const dest = pathValue || pathFlag || process.env.ZAP_PATH || config.path || path.basename(dir);
            const payload = { cmd: cmdValue || '', autoRestart, restartDelay, idleTimeout, path: dest };
            const { res, body } = await api('POST', '/api/v0/services', payload);
            if (res.statusCode !== 201) {
              console.error('Error creating service:', body);
              process.exit(1);
            }
            console.log(body);
            break;
          }
          case 'update': {
            const id = args[1];
            if (!id) {
              console.error('Usage: zap update <id> [--cmd <cmd>] [--auto-restart] [--restart-delay <sec>] [--idle-timeout <sec>] [--path <path>]');
              process.exit(1);
            }
            const payload = {};
            for (let i = 2; i < args.length; i++) {
              if (args[i] === '--cmd' && args[i+1]) payload.cmd = args[++i];
              else if (args[i] === '--auto-restart') payload.autoRestart = true;
              else if (args[i] === '--no-auto-restart') payload.autoRestart = false;
              else if (args[i] === '--restart-delay' && args[i+1]) payload.restartDelay = parseInt(args[++i], 10);
              else if (args[i] === '--idle-timeout' && args[i+1]) payload.idleTimeout = parseInt(args[++i], 10);
              else if (args[i] === '--path' && args[i+1]) payload.path = args[++i];
            }
            const { res, body } = await api('PUT', `/api/v0/services/${id}`, payload);
            if (res.statusCode !== 204) {
              console.error('Error updating service:', body);
              process.exit(1);
            }
            break;
          }
          case 'start':
          case 'stop': {
            const id = args[1];
          if (!id) {
              console.error(`Usage: zap ${sub} <id>`);
              process.exit(1);
            }
            const { res, body } = await api('POST', `/api/v0/services/${id}/${sub}`);
            if (res.statusCode !== 204) {
              console.error('Error:', body);
              process.exit(1);
            }
            break;
          }
          case 'delete': {
            const id = args[1];
            if (!id) {
              console.error('Usage: zap delete <id>');
              process.exit(1);
            }
            const { res, body } = await api('DELETE', `/api/v0/services/${id}`);
            if (res.statusCode !== 204) {
              console.error('Error:', body);
              process.exit(1);
            }
            break;
          }
          case 'logs': {
            const id = args[1];
            if (!id) {
              console.error('Usage: zap logs <id> [--since <ms>] [--until <ms>] [--limit <n>]');
              process.exit(1);
            }
            const params = [];
            for (let i = 2; i < args.length; i++) {
              if (args[i] === '--since' && args[i+1]) params.push(`since=${args[++i]}`);
              else if (args[i] === '--until' && args[i+1]) params.push(`until=${args[++i]}`);
              else if (args[i] === '--limit' && args[i+1]) params.push(`limit=${args[++i]}`);
            }
            const query = params.join('&');
            const { res, body } = await api('GET', `/api/v0/services/${id}/logs`, null, query);
            if (res.statusCode !== 200) {
              console.error('Error fetching logs:', body);
              process.exit(1);
            }
            console.log(body);
            break;
          }
          case 'clear-logs': {
            const id = args[1];
            if (!id) {
              console.error('Usage: zap clear-logs <id>');
              process.exit(1);
            }
            const { res, body } = await api('DELETE', `/api/v0/services/${id}/logs`);
            if (res.statusCode !== 204) {
              console.error('Error clearing logs:', body);
              process.exit(1);
            }
            break;
          }
          default:
            console.error('Unknown command:', sub);
            printHelp();
            process.exit(1);
        }
        break;
      }
      default:
        console.error('Unknown command:', cmd);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
