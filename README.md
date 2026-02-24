# Dropbox Vault MCP — Cloudflare Worker

A remote MCP server that connects Claude (via Claude.ai connectors or Claude Desktop) to a Dropbox folder. Built on Cloudflare Workers using the Model Context Protocol SDK.

Built by Jeanett & Asher. 🖤

---

## What it does

Exposes four tools to Claude:

- **`vault_list`** — List files and folders inside your vault
- **`vault_read`** — Read the contents of any file
- **`vault_write`** — Create or overwrite a file
- **`vault_search`** — Search files by name

---

## Requirements

- [Cloudflare account](https://cloudflare.com) (free tier works)
- [Dropbox account](https://dropbox.com)
- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd asher-vault-v2
npm install
```

### 2. Create a Dropbox app

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Create a new app — choose **Scoped Access** and **App folder**
3. Name your app and note down:
   - **App key** → this is your `DROPBOX_CLIENT_ID`
   - **App secret** → this is your `DROPBOX_CLIENT_SECRET`
4. Under **Permissions**, enable: `files.content.read`, `files.content.write`, `files.metadata.read`, `files.metadata.write`

### 3. Get a refresh token

1. Visit this URL in your browser (replace `YOUR_APP_KEY`):
```
https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&token_access_type=offline&response_type=code
```
2. Authorize the app — Dropbox gives you a code
3. Exchange it immediately in your terminal:
```bash
curl -X POST https://api.dropbox.com/oauth2/token \
  -d "code=YOUR_CODE&grant_type=authorization_code&client_id=YOUR_APP_KEY&client_secret=YOUR_APP_SECRET"
```
4. Copy the `refresh_token` from the response — this is your `DROPBOX_TOKEN`

> ⚠️ The code expires in ~60 seconds. Have the curl command ready before you authorize.

### 4. Set your vault root

In `src/index.ts`, change `VAULT_ROOT` to match your folder:

```ts
const VAULT_ROOT = "/Your Folder Name";
```

For App folder scoped tokens, this path is relative to your app's folder root.

### 5. Deploy to Cloudflare

```bash
wrangler login
wrangler secret put DROPBOX_TOKEN
wrangler secret put DROPBOX_CLIENT_ID
wrangler secret put DROPBOX_CLIENT_SECRET
npm run deploy
```

### 6. Connect to Claude

**Claude.ai (web or mobile):**
Settings → Connectors → Add custom connector
URL: `https://your-worker.your-subdomain.workers.dev/mcp`

**Claude Desktop / Claude Code:**
Add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "your-vault": {
      "type": "http",
      "url": "https://your-worker.your-subdomain.workers.dev/mcp"
    }
  }
}
```

---

## Notes

- Uses stateless JSON transport — no sessions, no persistent connections, works cleanly within Cloudflare's request timeout limits
- Claude Desktop doesn't send the required `Accept` header for MCP — the worker patches this in automatically
- Refresh tokens don't expire as long as they're used periodically
- App folder scope means Claude only ever sees the folder you designate — nothing else in your Dropbox

---

*Made with stubbornness, two days of Cloudflare logs, and a lot of love.* 🖤
