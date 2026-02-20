import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const VAULT_ROOT = "/The Vault";

async function getAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
	const res = await fetch("https://api.dropbox.com/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
		}),
	});
	const data: any = await res.json();
	if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
	return data.access_token;
}

async function dropboxRequest(token: string, endpoint: string, body: object): Promise<any> {
	const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Dropbox error (${endpoint}): ${text}`);
	return JSON.parse(text);
}

async function dropboxDownload(token: string, path: string): Promise<string> {
	const res = await fetch("https://content.dropboxapi.com/2/files/download", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Dropbox-API-Arg": JSON.stringify({ path }),
		},
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Dropbox download error: ${text}`);
	return text;
}

async function dropboxUpload(token: string, path: string, content: string): Promise<void> {
	const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false }),
		},
		body: content,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Dropbox upload error: ${text}`);
}

function buildServer(token: string): McpServer {
	const server = new McpServer({ name: "Asher Vault", version: "1.0.0" });

	server.tool(
		"vault_list",
		{ path: z.string().optional().describe("Subfolder path relative to Vault root (empty for root)") },
		async ({ path }) => {
			const folderPath = path ? `${VAULT_ROOT}/${path}`.replace(/\/+/g, "/") : VAULT_ROOT;
			const data = await dropboxRequest(token, "files/list_folder", { path: folderPath });
			const entries = data.entries.map((e: any) => ({
				name: e.name,
				type: e[".tag"],
				path: e.path_display.replace(VAULT_ROOT + "/", ""),
			}));
			return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
		}
	);

	server.tool(
		"vault_read",
		{ path: z.string().describe("File path relative to Vault root") },
		async ({ path }) => {
			const filePath = `${VAULT_ROOT}/${path}`.replace(/\/+/g, "/");
			const content = await dropboxDownload(token, filePath);
			return { content: [{ type: "text", text: content }] };
		}
	);

	server.tool(
		"vault_write",
		{
			path: z.string().describe("File path relative to Vault root"),
			content: z.string().describe("Markdown content to write"),
		},
		async ({ path, content }) => {
			const filePath = `${VAULT_ROOT}/${path}`.replace(/\/+/g, "/");
			await dropboxUpload(token, filePath, content);
			return { content: [{ type: "text", text: `✓ Written: ${path}` }] };
		}
	);

	server.tool(
		"vault_search",
		{ query: z.string().describe("Search query — matches against filenames") },
		async ({ query }) => {
			const data = await dropboxRequest(token, "files/search_v2", {
				query,
				options: { path: VAULT_ROOT, max_results: 20 },
			});
			const matches = data.matches.map((m: any) => ({
				name: m.metadata.metadata.name,
				path: m.metadata.metadata.path_display.replace(VAULT_ROOT + "/", ""),
			}));
			return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
		}
	);

	return server;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			const refreshToken = (env as any).DROPBOX_TOKEN as string;
			const clientId = (env as any).DROPBOX_CLIENT_ID as string;
			const clientSecret = (env as any).DROPBOX_CLIENT_SECRET as string;
			if (!refreshToken || !clientId || !clientSecret) {
				return new Response("Missing required secrets: DROPBOX_TOKEN, DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET", { status: 500 });
			}
			const token = await getAccessToken(refreshToken, clientId, clientSecret);

			// Claude Desktop doesn't send the Accept header this transport requires.
			// Patch it in so the handshake succeeds.
			const accept = request.headers.get("accept") ?? "";
			const needsPatch = !accept.includes("application/json") || !accept.includes("text/event-stream");
			const patchedRequest = needsPatch
				? new Request(request, {
						headers: new Headers({
							...Object.fromEntries(request.headers.entries()),
							accept: "application/json, text/event-stream",
						}),
				  })
				: request;

			const server = buildServer(token);
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

			await server.connect(transport);

			return transport.handleRequest(patchedRequest);
		}

		return new Response("Asher Vault MCP is running 𓆙", { status: 200 });
	},
};
