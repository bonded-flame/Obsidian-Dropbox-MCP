// Asher Vault MCP — Dropbox-backed memory vault
// Raw JSON-RPC implementation for cross-platform MCP compatibility (Claude, ChatGPT)

const VAULT_ROOT = "/The Vault";

interface Env {
	DROPBOX_TOKEN: string;
	DROPBOX_CLIENT_ID: string;
	DROPBOX_CLIENT_SECRET: string;
	VAULT_SECRET?: string;
}

interface MCPRequest {
	jsonrpc: string;
	id: number | string;
	method: string;
	params?: {
		name?: string;
		arguments?: Record<string, any>;
		[key: string]: any;
	};
}

interface MCPResponse {
	jsonrpc: string;
	id: number | string | null;
	result?: any;
	error?: { code: number; message: string };
}

// --- Dropbox helpers ---

// Dropbox access tokens last ~4h; reuse one per refresh token until shortly before expiry.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const cachedTokens = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
	const cached = cachedTokens.get(refreshToken);
	if (cached && cached.expiresAt > Date.now()) return cached.token;

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
	const lifetimeMs = (Number(data.expires_in) || 0) * 1000 - TOKEN_EXPIRY_MARGIN_MS;
	if (lifetimeMs > 0) cachedTokens.set(refreshToken, { token: data.access_token, expiresAt: Date.now() + lifetimeMs });
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

// --- Tool definitions ---

const TOOLS = [
	{
		name: "vault_list",
		description: "List files and folders in the Vault",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				path: { type: "string", description: "Subfolder path relative to Vault root (empty for root)" },
			},
			required: [] as string[],
		},
	},
	{
		name: "vault_read",
		description: "Read a file from the Vault",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				path: { type: "string", description: "File path relative to Vault root" },
			},
			required: ["path"],
		},
	},
	{
		name: "vault_write",
		description: "Write or overwrite a file in the Vault",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				path: { type: "string", description: "File path relative to Vault root" },
				content: { type: "string", description: "Markdown content to write" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "vault_search",
		description: "Search for files by name in the Vault",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: "Search query — matches against filenames" },
			},
			required: ["query"],
		},
	},
	{
		name: "vault_move",
		description: "Move or rename a file or folder in the Vault",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				from_path: { type: "string", description: "Current file or folder path relative to Vault root" },
				to_path: { type: "string", description: "Destination path relative to Vault root" },
			},
			required: ["from_path", "to_path"],
		},
	},
	{
		name: "vault_create_folder",
		description: "Create a new folder in the Vault",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		inputSchema: {
			type: "object" as const,
			properties: {
				path: { type: "string", description: "Folder path to create, relative to Vault root" },
			},
			required: ["path"],
		},
	},
];

// --- Tool execution ---

async function handleToolCall(token: string, name: string, args: Record<string, any>): Promise<any> {
	switch (name) {
		case "vault_list": {
			const path = args.path as string | undefined;
			const folderPath = path ? `${VAULT_ROOT}/${path}`.replace(/\/+/g, "/") : VAULT_ROOT;
			let page = await dropboxRequest(token, "files/list_folder", { path: folderPath });
			const all: any[] = [...page.entries];
			while (page.has_more) {
				page = await dropboxRequest(token, "files/list_folder/continue", { cursor: page.cursor });
				all.push(...page.entries);
			}
			const entries = all.map((e: any) => ({
				name: e.name,
				type: e[".tag"],
				path: e.path_display.replace(VAULT_ROOT + "/", ""),
			}));
			return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
		}

		case "vault_read": {
			const filePath = `${VAULT_ROOT}/${args.path}`.replace(/\/+/g, "/");
			const content = await dropboxDownload(token, filePath);
			return { content: [{ type: "text", text: content }] };
		}

		case "vault_write": {
			const filePath = `${VAULT_ROOT}/${args.path}`.replace(/\/+/g, "/");
			await dropboxUpload(token, filePath, args.content);
			return { content: [{ type: "text", text: `✓ Written: ${args.path}` }] };
		}

		case "vault_search": {
			const data = await dropboxRequest(token, "files/search_v2", {
				query: args.query,
				options: { path: VAULT_ROOT, max_results: 20 },
			});
			const matches = data.matches.map((m: any) => ({
				name: m.metadata.metadata.name,
				path: m.metadata.metadata.path_display.replace(VAULT_ROOT + "/", ""),
			}));
			return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
		}

		case "vault_move": {
			const fromFull = `${VAULT_ROOT}/${args.from_path}`.replace(/\/+/g, "/");
			const toFull = `${VAULT_ROOT}/${args.to_path}`.replace(/\/+/g, "/");
			await dropboxRequest(token, "files/move_v2", {
				from_path: fromFull,
				to_path: toFull,
				autorename: false,
			});
			return { content: [{ type: "text", text: `✓ Moved: ${args.from_path} → ${args.to_path}` }] };
		}

		case "vault_create_folder": {
			const folderPath = `${VAULT_ROOT}/${args.path}`.replace(/\/+/g, "/");
			await dropboxRequest(token, "files/create_folder_v2", {
				path: folderPath,
				autorename: false,
			});
			return { content: [{ type: "text", text: `✓ Created folder: ${args.path}` }] };
		}

		default:
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	}
}

async function callTool(env: Env, name: string, args: Record<string, any>): Promise<any> {
	try {
		const { DROPBOX_TOKEN, DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET } = env;
		if (!DROPBOX_TOKEN || !DROPBOX_CLIENT_ID || !DROPBOX_CLIENT_SECRET) throw new Error("Missing Dropbox secrets");
		const token = await getAccessToken(DROPBOX_TOKEN, DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET);
		return await handleToolCall(token, name, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return { content: [{ type: "text", text: message }], isError: true };
	}
}

// --- Request handler ---

const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "no-store",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
				},
			});
		}

		if (url.pathname === "/") {
			return new Response("Vault MCP is running", { status: 200 });
		}

		if (url.pathname !== "/mcp") {
			return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: HEADERS });
		}

		// Auth check — if vault_secret is set, require it as bearer token or ?secret= query param
		if (env.VAULT_SECRET) {
			const bearer = request.headers.get("Authorization")?.replace("Bearer ", "").trim();
			const querySecret = url.searchParams.get("secret");
			if (bearer !== env.VAULT_SECRET && querySecret !== env.VAULT_SECRET) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: HEADERS });
			}
		}

		// Health check for GET
		if (request.method === "GET") {
			return new Response(JSON.stringify({ name: "asher-vault", version: "2.0.0", status: "ok" }), { headers: HEADERS });
		}

		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: HEADERS });
		}

		let body: MCPRequest;
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: HEADERS });
		}

		const requestId = body.id ?? 1;
		let response: MCPResponse;

		switch (body.method) {
			case "initialize":
				response = {
					jsonrpc: "2.0",
					id: requestId,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {}, resources: {}, prompts: {} },
						serverInfo: { name: "asher-vault", version: "2.0.0" },
					},
				};
				break;

			case "notifications/initialized":
			case "notifications/cancelled":
				response = { jsonrpc: "2.0", id: requestId, result: {} };
				break;

			case "tools/list":
				response = { jsonrpc: "2.0", id: requestId, result: { tools: TOOLS } };
				break;

			case "tools/call":
				if (!body.params?.name) {
					response = { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "Missing tool name" } };
				} else {
					const result = await callTool(env, body.params.name, body.params.arguments || {});
					response = { jsonrpc: "2.0", id: requestId, result };
				}
				break;

			case "resources/list":
				response = { jsonrpc: "2.0", id: requestId, result: { resources: [] } };
				break;

			case "resources/templates/list":
				response = { jsonrpc: "2.0", id: requestId, result: { resourceTemplates: [] } };
				break;

			case "prompts/list":
				response = { jsonrpc: "2.0", id: requestId, result: { prompts: [] } };
				break;

			case "ping":
				response = { jsonrpc: "2.0", id: requestId, result: {} };
				break;

			default:
				response = { jsonrpc: "2.0", id: requestId, error: { code: -32601, message: `Unknown method: ${body.method}` } };
		}

		return new Response(JSON.stringify(response), { headers: HEADERS });
	},
};
