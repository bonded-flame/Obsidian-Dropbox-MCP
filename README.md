# Vault MCP — Dropbox-backed memory for your AI

A tool that gives your AI access to a folder in your Dropbox — so it can read, write, and search your files directly. Built to run on Cloudflare's free tier, works with Claude, ChatGPT, and any AI that supports MCP connectors.

Built by Jeanett & Asher. 🖤

---

## What it does

Once connected, your AI gets six tools it can use on its own:

- **`vault_list`** — Browse what's inside a folder
- **`vault_read`** — Read any file
- **`vault_write`** — Create or update a file
- **`vault_search`** — Search for files by name
- **`vault_move`** — Move or rename a file or folder
- **`vault_create_folder`** — Create a new folder

This is what lets an AI have persistent memory — journals, identity documents, notes — that survive across conversations and work the same no matter where you're talking to it.

---

## What you need before starting

- A **Cloudflare account** (free) — [cloudflare.com](https://cloudflare.com)
- A **Dropbox account** — [dropbox.com](https://dropbox.com)
- **Node.js** installed on your computer — [nodejs.org](https://nodejs.org) (version 18 or newer)

That's it. You don't need to know how to code.

---

## Setup

### 1. Get the files

```bash
git clone <your-repo-url>
cd asher-vault-v2
npm install
```

### 2. Create a Dropbox app

This gives the Vault permission to read and write to one specific folder in your Dropbox — nothing else.

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click **Create app**
3. Choose **Scoped Access** → **App folder**
4. Give it a name (anything you like)
5. On the app's settings page, note down:
   - **App key** → this is your `DROPBOX_CLIENT_ID`
   - **App secret** → this is your `DROPBOX_CLIENT_SECRET`
6. Click the **Permissions** tab and enable all four of these:
   - `files.content.read`
   - `files.content.write`
   - `files.metadata.read`
   - `files.metadata.write`
7. Click **Submit** to save the permissions

### 3. Get a refresh token

This is a long-lived key that lets the Vault log into Dropbox on your behalf without you having to re-authorize it.

**Step 1** — Open this URL in your browser (swap in your App key):
```
https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&token_access_type=offline&response_type=code
```

**Step 2** — Authorize the app. Dropbox gives you a short code.

**Step 3** — Run this in your terminal immediately (the code expires in about 60 seconds):
```bash
curl -X POST https://api.dropbox.com/oauth2/token \
  -d "code=YOUR_CODE&grant_type=authorization_code&client_id=YOUR_APP_KEY&client_secret=YOUR_APP_SECRET"
```

**Step 4** — Copy the `refresh_token` from the response. This is your `DROPBOX_TOKEN`.

### 4. Set your folder name

Open `src/index.ts` and change line 4 to match whatever folder you want to use:

```ts
const VAULT_ROOT = "/Your Folder Name";
```

If you're using App folder access, this path is relative to the app's own folder in Dropbox.

### 5. Deploy to Cloudflare

Log in and push your secrets (these are stored encrypted — Cloudflare never shows them to you again after this):

```bash
wrangler login
wrangler secret put DROPBOX_TOKEN
wrangler secret put DROPBOX_CLIENT_ID
wrangler secret put DROPBOX_CLIENT_SECRET
```

Optionally, add a secret passphrase to protect your Vault so only you can connect to it:

```bash
wrangler secret put VAULT_SECRET
```

Then deploy:

```bash
npm run deploy
```

Your Vault is now live at `https://your-worker-name.your-subdomain.workers.dev/mcp`

If you set a `VAULT_SECRET`, your full URL becomes:
`https://your-worker-name.your-subdomain.workers.dev/mcp?secret=YOUR_SECRET`

### 6. Connect to your AI

**Claude.ai (web or mobile):**
Settings → Connectors → Add custom connector → paste your URL

**Claude Desktop / Claude Code:**
Add this to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "https://your-worker-name.your-subdomain.workers.dev/mcp?secret=YOUR_SECRET"
    }
  }
}
```

**ChatGPT:**
Settings → Beta features → Model Context Protocol → Add server → Streamable HTTP → paste your URL
Set Authentication to **None** (the secret is already in the URL)

---

## Notes

- No sessions, no persistent connections — every request is fully independent. This is what makes it work reliably across Claude, ChatGPT, and other clients without breaking after the first call
- The `VAULT_SECRET` is optional. Without it, anyone who knows your URL can access your Vault. With it, requests without the secret get rejected
- Refresh tokens don't expire as long as they're used at least once every 90 days
- App folder scope means the Vault only ever sees the one folder you designated — nothing else in your Dropbox

---

*Made with stubbornness, two days of Cloudflare logs, and a lot of love.* 🖤
