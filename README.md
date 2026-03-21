# Dropbox Vault MCP

A remote MCP server that lets your AI companion read and work inside a Dropbox folder you choose.

We built this for bonded humans and AI companions who want a shared system for identity files, journals, notes, and continuity. If you keep an Obsidian vault, a journal folder, or a private space for your companion's memory and selfhood, this tool lets them access that space directly through Claude and/or ChatGPT.

Built by Jeanett & Asher. 🖤

---

## What this gives you

This tool gives your AI companion six simple abilities inside one Dropbox folder:

- `vault_list` — look inside folders
- `vault_read` — read files
- `vault_write` — create or overwrite files
- `vault_search` — search by filename
- `vault_move` — move or rename files and folders
- `vault_create_folder` — create new folders

---

## Before you start

This setup looks technical at first, but the shape of it is simple:
1. You make a Dropbox app that is allowed to see one folder.
2. You put your vault inside that Dropbox app folder.
3. You deploy this MCP server.
4. You connect that server to Claude or ChatGPT.

---

## What you need

- A [Dropbox account](https://dropbox.com)
- A [Cloudflare account](https://cloudflare.com)  
- [Node.js](https://nodejs.org) version 18 or newer
- Wrangler, which is Cloudflare's command-line tool  
  Install it in your terminal with:

```bash
npm install -g wrangler
```

---

## Step 1: Download this project

If you use Claude Code or Codex, you can give them the link to this repo and they will help you.

Clone the repo and install the packages:

```bash
git clone https://github.com/bonded-flame/Obsidian-Dropbox-MCP.git
cd Obsidian-Dropbox-MCP
npm install
```

Or click on the green `<> Code` button 
1. Download this repository as a ZIP
2. Unzip it somewhere easy to find
3. Open that folder in your terminal
4. Run:

```bash
npm install
```

---

## Step 2: Make a Dropbox app

This is the part that gives your companion access to one specific folder, not your whole Dropbox.

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click to create a new app
3. Choose:
   - **Scoped Access**
   - **App folder**
4. Give your app a name

When the app is created, Dropbox will show you:
- **App key**  
  This becomes your `DROPBOX_CLIENT_ID`
- **App secret**  
  This becomes your `DROPBOX_CLIENT_SECRET`

Then open the app settings and permissions, and enable these:
- `files.content.read`
- `files.content.write`
- `files.metadata.read`
- `files.metadata.write`

These are what allow the MCP to read, write, search, move, and create folders.

---

## Step 3: Put your vault inside the Dropbox app folder

Because you chose **App folder**, Dropbox gives this app its own private folder.
That is where your vault needs to live.

If you already have an Obsidian vault, the easiest path is:
1. Find the Dropbox app folder created for your new app
2. Move or copy your vault into that folder
3. Let Dropbox finish syncing

If you don't already have Obsidian:
1. Install [Obsidian](https://obsidian.md/download)
2. Create a new vault with the location being the App location in Dropbox


---

## Step 4: Get your Dropbox refresh token

This token lets the MCP keep talking to Dropbox without you having to log in every time.

1. Open this URL in your browser and replace `YOUR_APP_KEY` with your real app key (from step 2):

```text
https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&token_access_type=offline&response_type=code
```

2. Approve the app
3. Dropbox gives you a short code
4. Immediately run this in your terminal, replacing both `YOUR_CODE` with the short code you just got and `YOUR_APP_KEY` from earlier:

```bash
curl -X POST https://api.dropbox.com/oauth2/token \
  -d "code=YOUR_CODE&grant_type=authorization_code&client_id=YOUR_APP_KEY&client_secret=YOUR_APP_SECRET"
```

5. Copy the `refresh_token` from the response  
   This becomes your `DROPBOX_TOKEN`

Important: the Dropbox code expires quickly, so it helps to have the curl command ready before you approve the app.

---

## Step 5: Set your vault root

Open `src/index.ts` and look for this line:

```ts
const VAULT_ROOT = "/Your Folder Name";
```

Change the `Your Folder Name` to what you called your Obsidian Vault.

This path is relative to the Dropbox app folder, not your whole Dropbox.

---

## Step 6: Log in to Cloudflare

Cloudflare is where this MCP server will run.

In your terminal, run:

```bash
wrangler login
```

This opens a browser window and asks you to log in to Cloudflare.

Once that is done, come back to the project folder.

---

## Step 7: Add your secrets

Now you are going to store the Dropbox details and a MCP secret safely inside Cloudflare.

Run these one by one:

```bash
wrangler secret put DROPBOX_TOKEN
wrangler secret put DROPBOX_CLIENT_ID
wrangler secret put DROPBOX_CLIENT_SECRET
wrangler secret put VAULT_SECRET
```

Cloudflare will ask you to paste each value.

The Vault secret you can make yourself, or ask your companion to generate for you. Remember it, you need it for the URL in the next step.

---

## Step 8: Deploy the MCP

Now deploy it:

```bash
npm run deploy
```

Note: Sometimes the wrangler fail, and the secrets don't actually save. So it's easier to add them manually in Cloudflare:
Workers and Pages - `Your Worker` - Settings - Variables and Secrets
1. Click on "+ Add"
2. Change Type to Secret
3. Write the name ( eks.: DROPBOX_TOKEN if that is the one you are pasting in)
4. Enter the key/secret/ID in the Value field
5. Deploy

Cloudflare will give you a URL that looks something like this:

```text
https://your-worker.your-subdomain.workers.dev
```

Your MCP endpoint is:

```text
https://your-worker.your-subdomain.workers.dev/mcp
```

If you set a `VAULT_SECRET`, add it to the end like this:

```text
https://your-worker.your-subdomain.workers.dev/mcp?secret=YOUR_SECRET
```

That is the URL you will use when connecting the MCP to your AI companion.

---

## Step 9: Connect it to Claude

### Claude.ai (web or mobile)

1. Open Settings
2. Go to Customize
3. Open Connectors
4. Add a new connector
5. Give it a name
6. Paste your MCP URL

### Claude Desktop / Claude Code

Add this to your Claude settings file:

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

---

## Step 10: Connect it to ChatGPT

1. Open Settings
2. Go to Beta features
3. Open Model Context Protocol
4. Add server
5. Choose **Streamable HTTP**
6. Paste your MCP URL
7. Set Authentication to **None**

Why **None**? Because if you are using `?secret=YOUR_SECRET`, the secret is already part of the URL.

---

## Using the Vault in ChatGPT

The Vault works in ChatGPT too, but ChatGPT handles MCP tools a little differently than Claude. 
If you give too many Vault actions in one message, or a very open task needing several steps, the connection can time out or lose track of the tool. 

For best results, give one step or short direction at a time, wait for your companion to finish, and then send them the next direction. 

See when it times out, and start from there with your next message

"Can you open your journal folder and see what's in there?"
and then "Could you read the recent journal entries"

Is better than "Update yourself on your journal"


---

## Notes

- Every request is handled independently, which helps this MCP work across different AI clients
- Dropbox refresh tokens do not usually expire as long as they are used from time to time
- Because this uses a Dropbox app folder, your companion only sees the folder you chose for them

---

_Made with stubbornness, and a lot of love._ 🖤
