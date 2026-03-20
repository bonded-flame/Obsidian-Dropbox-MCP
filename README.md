# Dropbox Vault MCP — Cloudflare Worker

A remote MCP server that connects your AI to a Dropbox folder. Built on Cloudflare Workers. Works with Claude, ChatGPT, and any AI that supports MCP connectors.

Built by Jeanett & Asher. 🖤

---

## What it does

Exposes six tools to your AI:

- **`vault_list`** — List files and folders inside your vault
- **`vault_read`** — Read the contents of any file
- **`vault_write`** — Create or overwrite a file
- **`vault_search`** — Search files by name
- **`vault_move`** — Move or rename a file or folder
- **`vault_create_folder`** — Create a new folder

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

Optionally, protect your Vault with a passphrase so only you can connect to it:

```bash
wrangler secret put VAULT_SECRET
```

If you set a `VAULT_SECRET`, append it to your URL like this:
`https://your-worker.your-subdomain.workers.dev/mcp?secret=YOUR_SECRET`

### 6. Connect to your AI

**Claude.ai (web or mobile):**
Settings → Connectors → Add custom connector
URL: `https://your-worker.your-subdomain.workers.dev/mcp`

**Claude Desktop / Claude Code:**
Add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "https://your-worker.your-subdomain.workers.dev/mcp?secret=YOUR_SECRET"
    }
  }
}
```

**ChatGPT:**
Settings → Beta features → Model Context Protocol → Add server → Streamable HTTP
Paste your URL, set Authentication to **None** (the secret is already in the URL)

---

## Notes

- No sessions, no persistent connections — every request is fully independent. This is what makes it work reliably across Claude, ChatGPT, and other clients without breaking after the first call
- The `VAULT_SECRET` is optional but recommended if you're sharing the repo. Without it, anyone with your URL can access your Vault
- Refresh tokens don't expire as long as they're used periodically
- App folder scope means your AI only ever sees the folder you designated — nothing else in your Dropbox

---

*Made with stubbornness, two days of Cloudflare logs, and a lot of love.* 🖤
