import http, { IncomingMessage, ServerResponse } from "http";
import { spawn, ChildProcess } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import path from "path";
import { URL } from "url";
import crypto from "crypto";
import 'dotenv/config';

// parse CLI options to override environment variables before startup
const cliArgs = process.argv.slice(2);
for (let i = 0; i < cliArgs.length; i++) {
  const a = cliArgs[i];
  if (a === '--token' && cliArgs[i + 1]) {
    process.env.ZAP_TOKEN = cliArgs[++i];
  } else if (a === '--username' && cliArgs[i + 1]) {
    process.env.ZAP_USERNAME = cliArgs[++i];
  } else if (a === '--password' && cliArgs[i + 1]) {
    process.env.ZAP_PASSWORD = cliArgs[++i];
  } else if (a === '--secret' && cliArgs[i + 1]) {
    process.env.ZAP_SECRET = cliArgs[++i];
  } else if (a === '--port' && cliArgs[i + 1]) {
    process.env.ZAP_PORT = cliArgs[++i];
  } else if (a === '--help') {
    console.log(`Usage: zap-host [options]
Options:
  --token <token>     API token override (overrides ZAP_TOKEN env)
  --username <user>   login username override (overrides ZAP_USERNAME env)
  --password <pw>     login password override (overrides ZAP_PASSWORD env)
  --secret <secret>   JWT secret override (overrides ZAP_SECRET env)
  --port <port>       listening port override (overrides ZAP_PORT env)
`);
    process.exit(0);
  }
}

/**
 * Stop the given service and disable auto-restart.
 */
function stopServiceProcess(service: Service) {
	// fully stop process and clear timers
	service.status = "stopped";
	if (service.restartTimer) {
		clearTimeout(service.restartTimer);
		delete service.restartTimer;
	}
	if (service.idleTimer) {
		clearTimeout(service.idleTimer);
		delete service.idleTimer;
	}
	if (service.removalTimer) {
		clearTimeout(service.removalTimer);
		delete service.removalTimer;
	}
	if (service.process?.pid) {
		try {
			process.kill(-service.process.pid);
		} catch {
			service.process.kill();
		}
	}
}

/**
 * Schedule stopping the service after a period of inactivity.
 */
function scheduleIdleTimer(service: Service) {
	// reset existing idle timer, then schedule inactivity stop if desired
	if (service.idleTimer) {
		clearTimeout(service.idleTimer);
		delete service.idleTimer;
	}
	if (service.idleTimeout > 0) {
		service.lastActivity = Date.now();
		service.idleTimer = setTimeout(() => {
			console.log(`Stopping service ${service.id} due to inactivity after ${service.idleTimeout}ms`);
			stopServiceProcess(service);
		}, service.idleTimeout);
	}
}

interface Service {
  id: string;
  process?: ChildProcess;
  cmd: string;
  args: string[];
  /** Working directory path where the service is executed */
  path: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number | null;
  autoRestart: boolean;
  restartDelay: number;
  /** whether the service is ephemeral (started via exec) */
  ephemeral: boolean;
  restartTimer?: NodeJS.Timeout;
  /** inactivity timeout in ms (0 disables auto-stop) */
  idleTimeout: number;
  /** timestamp of last log activity */
  lastActivity?: number;
  /** timer to automatically stop service after inactivity */
  idleTimer?: NodeJS.Timeout;
  /** timestamp when the service last stopped or exited */
  finishedAt?: number;
  /** timer to automatically remove ephemeral services after exit */
  removalTimer?: NodeJS.Timeout;
  logs: { timestamp: number; line: string }[];
}

const services = new Map<string, Service>();

function startServiceProcess(service: Service) {
  // clear any existing timers before (re)starting
  if (service.restartTimer) {
    clearTimeout(service.restartTimer);
    delete service.restartTimer;
  }
  if (service.idleTimer) {
    clearTimeout(service.idleTimer);
    delete service.idleTimer;
  }
  if (service.removalTimer) {
    clearTimeout(service.removalTimer);
    delete service.removalTimer;
  }
  service.status = "running";
  service.exitCode = undefined;
  const child = spawn(service.cmd, { shell: true, cwd: service.path, detached: true });
  service.process = child;
  child.unref();
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line) service.logs.push({ timestamp: Date.now(), line });
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line) service.logs.push({ timestamp: Date.now(), line: "[stderr] " + line });
    }
  });
  child.on("exit", (code) => {
    // ignore exit events from superseded processes
    if (service.process !== child) return;
    service.exitCode = code;
    service.finishedAt = Date.now();
    if (service.status !== "stopped") {
      service.status = "exited";
      if (service.autoRestart) {
        service.restartTimer = setTimeout(() => {
          startServiceProcess(service);
        }, service.restartDelay);
      }
    }
    if (service.ephemeral && !service.removalTimer) {
      service.removalTimer = setTimeout(() => {
        services.delete(service.id);
      }, 5000);
    }
  });
}

const ZAP_USERNAME = process.env.ZAP_USERNAME;
const ZAP_PASSWORD = process.env.ZAP_PASSWORD;
const ZAP_TOKEN = process.env.ZAP_TOKEN;
const ZAP_SECRET = process.env.ZAP_SECRET || crypto.randomBytes(32).toString('hex');
if (!ZAP_TOKEN) {
  console.error("Missing ZAP_TOKEN environment variable");
  process.exit(1);
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str: string): Buffer {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad === 2) str += "==";
  else if (pad === 3) str += "=";
  else if (pad === 1) str += "===";
  return Buffer.from(str, "base64");
}

function signJwt(payload: Record<string, any>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEnc = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadEnc = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.createHmac("sha256", secret).update(`${headerEnc}.${payloadEnc}`).digest();
  const sigEnc = base64UrlEncode(sig);
  return `${headerEnc}.${payloadEnc}.${sigEnc}`;
}

function verifyJwt(token: string, secret: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerEnc, payloadEnc, sigEnc] = parts;
  const signature = crypto.createHmac("sha256", secret).update(`${headerEnc}.${payloadEnc}`).digest();
  const sigCheck = base64UrlEncode(signature);
  if (!crypto.timingSafeEqual(Buffer.from(sigEnc), Buffer.from(sigCheck))) return null;
  const payload = JSON.parse(base64UrlDecode(payloadEnc).toString("utf8"));
  if (payload.exp && Date.now() >= payload.exp * 1000) return null;
  return payload;
}

function getTokenFromReq(req: IncomingMessage): string | null {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const [scheme, token] = authHeader.split(" ");
    if (scheme === "Bearer" && token) return token;
  }
  const cookieHeader = req.headers["cookie"];
  if (typeof cookieHeader === "string") {
    for (const pair of cookieHeader.split(";")) {
      const [k, v] = pair.trim().split("=");
      if (k === "token" && v) return decodeURIComponent(v);
    }
  }
  return null;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = getTokenFromReq(req);
  if (!token) return false;
  const payload = verifyJwt(token, ZAP_SECRET);
  if (!payload || payload.sub !== ZAP_USERNAME) return false;
  return true;
}

const PORT = process.env.ZAP_PORT ? parseInt(process.env.ZAP_PORT, 10) : 5000;

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  if (!req.url || !req.method) {
    res.writeHead(400);
    res.end("Invalid request");
    return;
  }
  const { url, method } = req;
  const u = new URL(url, `http://${req.headers.host}`);

  if (method === "GET" && url === "/") {
    try {
      const html = readFileSync(path.join(__dirname, "zap-ui.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end("Failed to load UI");
    }
    return;
  }

  // Serve static image files
  if (method === "GET" && url.match(/\.(png|jpg|jpeg|gif|svg|ico)$/i)) {
    try {
      const imagePath = path.join(__dirname, url);
      const imageData = readFileSync(imagePath);
      const extension = path.extname(url).toLowerCase();
      let contentType = "image/png";

      if (extension === ".jpg" || extension === ".jpeg") contentType = "image/jpeg";
      else if (extension === ".gif") contentType = "image/gif";
      else if (extension === ".svg") contentType = "image/svg+xml";
      else if (extension === ".ico") contentType = "image/x-icon";

      res.writeHead(200, { "Content-Type": contentType });
      res.end(imageData);
    } catch (err) {
      res.writeHead(404);
      res.end("Image not found");
    }
    return;
  }

  if (method === "POST" && u.pathname === "/api/v0/login") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let creds: any;
      try {
        creds = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }
      const { username, password } = creds;
      if (username === ZAP_USERNAME && password === ZAP_PASSWORD) {
        const iat = Math.floor(Date.now() / 1000);
        const payload = { sub: ZAP_USERNAME, iat, exp: iat + 24 * 3600 };
        const token = signJwt(payload, ZAP_SECRET);
        res.writeHead(200, {
          "Set-Cookie": `token=${token}; HttpOnly; Path=/`,
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({ token }));
      } else {
        res.writeHead(401);
        res.end("Unauthorized");
      }
    });
    return;
  }

  // Token exchange endpoint: accept API token and issue a signed JWT
  if (method === "POST" && u.pathname === "/api/v0/token") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let data: any;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }
    if (data.token === ZAP_TOKEN) {
        const iat = Math.floor(Date.now() / 1000);
        const payload = { sub: ZAP_USERNAME, iat, exp: iat + 24 * 3600 };
        const jwt = signJwt(payload, ZAP_SECRET);
        res.writeHead(200, {
          "Set-Cookie": `token=${jwt}; HttpOnly; Path=/`,
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({ token: jwt }));
      } else {
        res.writeHead(401);
        res.end("Unauthorized");
      }
    });
    return;
  }

  if (!isAuthenticated(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    res.end("Unauthorized");
    return;
  }

  if (method === "POST" && u.pathname === "/api/v0/sync") {
    const baseTarget = process.env.SYNC_DIR || path.resolve(process.cwd(), "zaps");
    const dest = u.searchParams.get("path");
    const targetDir = dest
      ? (path.isAbsolute(dest) ? dest : path.resolve(baseTarget, dest))
      : baseTarget;
    mkdirSync(targetDir, { recursive: true });

    const tar = spawn("tar", ["-xz", "-C", targetDir]);
    req.pipe(tar.stdin!);

    tar.on("error", (err) => {
      console.error("tar error:", err);
      res.writeHead(500);
      res.end("Extraction failed: " + err.message);
    });

    tar.on("close", (code) => {
      if (code === 0) {
        res.writeHead(200);
        res.end("Sync completed");
      } else {
        res.writeHead(500);
        res.end("Extraction failed with code " + code);
      }
    });

    return;
  }


  if (url.startsWith("/api/v0/services")) {
    const [pathname, query] = url.split("?");
    const parts = pathname.split("/");

    if (method === "GET" && parts.length === 4) {
      const list = Array.from(services.values()).map((service) => ({
        id: service.id,
        path: service.path,
        cmd: service.cmd,
        args: service.args,
        status: service.status,
        exitCode: service.exitCode,
        pid: service.process?.pid ?? null,
        autoRestart: service.autoRestart,
        restartDelay: service.restartDelay / 1000,
        ephemeral: service.ephemeral,
        finishedAt: service.finishedAt,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (method === "POST" && parts.length === 4) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let cmd: string;
        let autoRestart = false;
        let restartDelayMs = 0;
        let idleTimeoutMs = 0;
        let destPath: string | undefined;
        let ephemeral = false;
        let nameValue: string | undefined;
        try {
          const json = JSON.parse(body);
          cmd = json.cmd;
          if (typeof cmd !== "string") throw new Error();
          if ("name" in json) {
            if (typeof json.name !== "string") throw new Error();
            nameValue = json.name;
          }
          if ("autoRestart" in json) {
            if (typeof json.autoRestart !== "boolean") throw new Error();
            autoRestart = json.autoRestart;
          }
          if ("restartDelay" in json) {
            if (typeof json.restartDelay !== "number" || json.restartDelay < 0) {
              throw new Error();
            }
            restartDelayMs = json.restartDelay * 1000;
          }
          if ("path" in json) {
            if (typeof json.path !== "string") throw new Error();
            destPath = json.path;
          }
          if ("ephemeral" in json) {
            if (typeof json.ephemeral !== "boolean") throw new Error();
            ephemeral = json.ephemeral;
          }
          if ("idleTimeout" in json) {
            if (typeof json.idleTimeout !== "number" || json.idleTimeout < 0) throw new Error();
            idleTimeoutMs = json.idleTimeout * 1000;
          }
        } catch {
          res.writeHead(400);
          res.end(
            "Invalid JSON payload, expected { cmd: string, name?: string, autoRestart?: boolean, restartDelay?: number, idleTimeout?: number, path?: string, ephemeral?: boolean }"
          );
          return;
        }

        // determine and prepare working directory for the service
        const baseTarget = process.env.SYNC_DIR || path.resolve(process.cwd(), "zaps");
        const targetDir = destPath
          ? (path.isAbsolute(destPath) ? destPath : path.resolve(baseTarget, destPath))
          : baseTarget;
        mkdirSync(targetDir, { recursive: true });
        // if a name is provided and a service with that name exists, restart/update it
        if (nameValue && services.has(nameValue)) {
          const svc = services.get(nameValue)!;
          svc.cmd = cmd;
          svc.autoRestart = autoRestart;
          svc.restartDelay = restartDelayMs;
          svc.idleTimeout = idleTimeoutMs;
          svc.ephemeral = ephemeral;
          svc.path = targetDir;
          stopServiceProcess(svc);
          startServiceProcess(svc);
          scheduleIdleTimer(svc);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: nameValue }));
          return;
        }
        const id = nameValue ?? crypto.randomBytes(3).toString("hex");
        const service: Service = {
          id,
          cmd,
          args: [],
          path: targetDir,
          status: "running",
          autoRestart,
          restartDelay: restartDelayMs,
          ephemeral,
          logs: [],
          idleTimeout: idleTimeoutMs,
          lastActivity: Date.now(),
        };
        services.set(id, service);
        if (!service.cmd) {
          service.status = 'stopped';
        } else {
          startServiceProcess(service);
          scheduleIdleTimer(service);
        }

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id }));
      });
      return;
    }

    // GET /api/v0/services/:id - get a single service configuration
    if (method === "GET" && parts.length === 5) {
      const id = parts[4];
      const service = services.get(id);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: service.id,
          path: service.path,
          cmd: service.cmd,
          args: service.args,
          status: service.status,
          exitCode: service.exitCode,
          pid: service.process?.pid ?? null,
          autoRestart: service.autoRestart,
          restartDelay: service.restartDelay / 1000,
          ephemeral: service.ephemeral,
          finishedAt: service.finishedAt,
        }),
      );
      return;
    }

    // PUT /api/v0/services/:id - update service configuration
    if (method === "PUT" && parts.length === 5) {
      const id = parts[4];
      const service = services.get(id);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let cmd = service.cmd;
        let autoRestart = service.autoRestart;
        let restartDelayMs = service.restartDelay;
        let idleTimeoutMs = service.idleTimeout;
        let destPath = service.path;
        try {
          const json = JSON.parse(body);
          if ("cmd" in json) {
            if (typeof json.cmd !== "string") throw new Error();
            cmd = json.cmd;
          }
          if ("autoRestart" in json) {
            if (typeof json.autoRestart !== "boolean") throw new Error();
            autoRestart = json.autoRestart;
          }
          if ("restartDelay" in json) {
            if (typeof json.restartDelay !== "number" || json.restartDelay < 0) throw new Error();
            restartDelayMs = json.restartDelay * 1000;
          }
          if ("path" in json) {
            if (typeof json.path !== "string") throw new Error();
            const baseTarget = process.env.SYNC_DIR || path.resolve(process.cwd(), "zaps");
            destPath = path.isAbsolute(json.path)
              ? json.path
              : path.resolve(baseTarget, json.path);
            mkdirSync(destPath, { recursive: true });
          }
          if ("idleTimeout" in json) {
            if (typeof json.idleTimeout !== "number" || json.idleTimeout < 0) throw new Error();
            idleTimeoutMs = json.idleTimeout * 1000;
          }
        } catch {
        res.writeHead(400);
        res.end(
          "Invalid JSON payload, expected { cmd?: string, autoRestart?: boolean, restartDelay?: number, idleTimeout?: number, path?: string }",
        );
          return;
        }
        service.cmd = cmd;
        service.autoRestart = autoRestart;
        service.restartDelay = restartDelayMs;
        service.path = destPath;
        service.idleTimeout = idleTimeoutMs;
        if (service.idleTimer) {
          clearTimeout(service.idleTimer);
          delete service.idleTimer;
        }
        scheduleIdleTimer(service);
        res.writeHead(204);
        res.end();
      });
      return;
    }

    // POST /api/v0/services/:id/start - start or restart a stopped service
    if (method === "POST" && parts.length === 6 && parts[5] === "start") {
      const id = parts[4];
      const service = services.get(id);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      if (service.status === "running") {
        res.writeHead(400);
        res.end("Service already running");
        return;
      }
      startServiceProcess(service);
      res.writeHead(204);
      res.end();
      return;
    }

    // POST /api/v0/services/:id/stop - stop a running service (disable auto-restart)
    if (method === "POST" && parts.length === 6 && parts[5] === "stop") {
      const id = parts[4];
      const service = services.get(id);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      stopServiceProcess(service);
      res.writeHead(204);
      res.end();
      return;
    }

    // DELETE /api/v0/services/:id - remove a service (stop it and delete from registry)
    if (method === "DELETE" && parts.length === 5) {
      const id = parts[4];
      const service = services.get(id);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      service.autoRestart = false;
      if (service.restartTimer) {
        clearTimeout(service.restartTimer);
        delete service.restartTimer;
      }
      if (service.process?.pid) {
        try {
          process.kill(-service.process.pid);
        } catch {
          service.process.kill();
        }
      }
      services.delete(id);
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /api/v0/services/:id/logs - fetch service logs (supports ?since=<ms>&until=<ms>&limit=<n>)
    if (method === "GET" && parts.length === 6 && parts[5] === "logs") {
      const params = new URLSearchParams(query || "");
      const since = params.has("since") ? parseInt(params.get("since")!, 10) : 0;
      const until = params.has("until") ? parseInt(params.get("until")!, 10) : Date.now();
      const limit = params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined;
      const service = services.get(parts[4]);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      let entries = service.logs.filter((e) => e.timestamp > since && e.timestamp <= until);
      if (limit != null) entries = entries.slice(-limit);
      // reset inactivity timer on each log fetch (CLI activity)
      if (service.idleTimeout > 0) {
        if (service.idleTimer) {
          clearTimeout(service.idleTimer);
          delete service.idleTimer;
        }
        scheduleIdleTimer(service);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
      return;
    }
    // DELETE /api/v0/services/:id/logs - clear service logs
    if (method === "DELETE" && parts.length === 6 && parts[5] === "logs") {
      const service = services.get(parts[4]);
      if (!service) {
        res.writeHead(404);
        res.end("Service not found");
        return;
      }
      service.logs = [];
      res.writeHead(204);
      res.end();
      return;
    }
    // POST /api/v0/services/:id/send - send a line to service stdin
    if (method === "POST" && parts.length === 6 && parts[5] === "send") {
      const service = services.get(parts[4]);
      if (!service || !service.process || !service.process.stdin) {
        res.writeHead(404);
        res.end("Service not found or not running");
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let data: any;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON payload");
          return;
        }
        const input = data.input;
        if (typeof input !== "string") {
          res.writeHead(400);
          res.end("Invalid payload, expected { input: string }");
          return;
        }
        // write to stdin (append newline)
        const proc = service.process!;
        const stdin = proc.stdin!;
        stdin.write(input + "\n");
        res.writeHead(204);
        res.end();
      });
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Orchestrator listening on port ${PORT}`);
});
