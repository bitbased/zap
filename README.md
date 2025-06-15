# Zap Reactive Deployment

## Basic CLI Usage

Use the `zap` command to sync local directories, run scripts, and manage services on a remote host.

Zap also supports **SSH mode**, where it uses `--host ssh://user@host` to push files and execute commands over SSH directly—no Zap server needs to be running on the remote side.

### Run Scripts with the Appropriate Interpreter

Zap will pick the interpreter based on file extension:

```bash
# Python scripts
zap run script.py         # invokes python3 script.py

# JavaScript files
zap run script.js         # invokes node script.js

# TypeScript files (requires ts-node installed locally or globally)
zap run script.ts         # invokes ts-node script.ts

# NPM scripts (fallback)
zap run my-script         # invokes npm run my-script

> If your project’s `package.json` includes a `zap:pre` script, Zap will run it automatically before invoking your main script.
```

### Common Commands

```bash
# One-time sync of the current directory
zap --host user@host sync

# Sync then execute locally-defined script
zap --host user@host sync run script.py

# Continuously sync and restart on changes
zap --host user@host --sync exec npm start

# Direct remote execution of an arbitrary shell command as a service
zap --host user@host --exec 'ls -a ./dist'

# List services
zap --host user@host list

# Detailed help
zap --help
```

### Configuration

Zap can load configuration from these sources, in order (first wins):

1. CLI flags (e.g. `--host`, `--key`, `--config`)
2. Environment variables or a `.env` file (e.g. `ZAP_HOST`, `ZAP_KEY`, `ZAP_SYNC`, `ZAP_IGNORE`, etc.)
3. `zapconfig.json` file in the working directory
4. `zap` field in `package.json`

   For example, add a `zap` section to your `package.json`:

   ```json
   {
     "zap": {
       "host": "myhost",
       "key": "<api-token>",
       "sync": true,
       "ignore": ["node_modules", "dist"]
     }
   }
   ```

---

## Server Usage

Follow these steps to run the Zap host server:

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file in the project root and set required environment variables:

   ```bash
   ZAP_TOKEN=<your_api_token>
   ZAP_SECRET=<your_jwt_secret>
   ZAP_PORT=<optional_port (default: 3000)>
   ```

3. Start the host server:

   ```bash
   npm run host -- [--token <token>] [--username <user>] [--password <pass>] [--secret <secret>] [--port <port>]
   ```

   You can also use `npm run host` and rely on values in `.env`.

## Advanced Client Usage

Use the Zap CLI to interact with the host server:

1. Install the CLI globally (optional):

   ```bash
   npm install -g .
   ```

2. Or use `npx` without a global install:

   ```bash
   npx zap --host <host_address> [options] <command> [args...]
   ```

3. Common commands:

   ```bash
   # Sync current directory to the remote host
   zap --host user@host sync

   # Run a command on the remote host after syncing
   zap --host user@host sync run npm start

   # Continuously sync while running a remote command
   zap --host user@host --sync exec npm start

   # List services
   zap --host user@host list
   ```

For full details on commands and options, run:

```bash
zap --help
```

### Docker Usage

Follow these steps to launch Zap via Docker:

1. Ensure Docker and Docker Compose v2 are installed.

2. Create a `.env` file with at least `ZAP_TOKEN` and `ZAP_SECRET`:

   ```bash
   ZAP_TOKEN=<your_api_token>
   ZAP_SECRET=<your_jwt_secret>
   ```

3. Start the containers:

   ```bash
   docker compose -f docker-compose.yml -p zap-host up --build -d
   ```

4. To stop and remove the containers:

   ```bash
   docker compose -f docker-compose.yml -p zap-host down
   ```

#### Mounting Additional Volumes

If you need arbitrary extra mounts (e.g. host folders or data volumes), use a Compose override file:

1. Create `docker-compose.override.yml` alongside `docker-compose.base.yml`:

   ```yaml
   version: '3.9'
   services:
     server:
       volumes:
         - /path/on/host/foo:/mydata/foo
         - /mnt/datasets:/mydata/data/datasets
   ```

2. Launch with both files so that your overrides are merged:

   ```bash
   docker compose \
     -f docker-compose.yml \
     -f docker-compose.override.yml \
     up -d
   ```
