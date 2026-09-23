import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";

type FakeDropbox = (url: string, init: RequestInit) => Response;

let refreshTokenCounter = 0;

function makeEnv() {
	refreshTokenCounter += 1;
	return {
		DROPBOX_TOKEN: `refresh-${refreshTokenCounter}`,
		DROPBOX_CLIENT_ID: "client",
		DROPBOX_CLIENT_SECRET: "client-secret",
		VAULT_SECRET: "s",
	};
}

function withDropbox(fake: FakeDropbox): { calls: string[]; restore: () => void } {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		return fake(url, init ?? {});
	}) as typeof fetch;
	return { calls, restore: () => (globalThis.fetch = original) };
}

const tokenOk = () => Response.json({ access_token: "access", expires_in: 14400 });

async function rpc(env: ReturnType<typeof makeEnv>, body: unknown) {
	const request = new Request("https://vault.test/mcp?secret=s", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const response = await worker.fetch(request, env as never);
	return { status: response.status, json: (await response.json()) as any };
}

test("tools/list answers without contacting Dropbox", async () => {
	const dropbox = withDropbox(() => {
		throw new Error("Dropbox should not be called");
	});
	try {
		const { status, json } = await rpc(makeEnv(), { jsonrpc: "2.0", id: 7, method: "tools/list" });
		assert.equal(status, 200);
		assert.equal(json.id, 7);
		assert.ok(json.result.tools.length > 0);
		assert.equal(dropbox.calls.length, 0);
	} finally {
		dropbox.restore();
	}
});

test("initialize still works while Dropbox token refresh is failing", async () => {
	const dropbox = withDropbox(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
	try {
		const { status, json } = await rpc(makeEnv(), { jsonrpc: "2.0", id: 1, method: "initialize" });
		assert.equal(status, 200);
		assert.equal(json.result.serverInfo.name, "asher-vault");
	} finally {
		dropbox.restore();
	}
});

test("a failing tool comes back as a tool error answering the same request id", async () => {
	const dropbox = withDropbox((url) =>
		url.includes("oauth2/token")
			? tokenOk()
			: new Response('{"error_summary":"path/not_found/"}', { status: 409 })
	);
	try {
		const { status, json } = await rpc(makeEnv(), {
			jsonrpc: "2.0",
			id: 42,
			method: "tools/call",
			params: { name: "vault_read", arguments: { path: "missing.md" } },
		});
		assert.equal(status, 200);
		assert.equal(json.id, 42);
		assert.equal(json.error, undefined);
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /not_found/);
	} finally {
		dropbox.restore();
	}
});

test("a failed token refresh during a tool call is a tool error, not a broken response", async () => {
	const dropbox = withDropbox(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
	try {
		const { status, json } = await rpc(makeEnv(), {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "vault_list", arguments: {} },
		});
		assert.equal(status, 200);
		assert.equal(json.id, 5);
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /Token refresh failed/);
	} finally {
		dropbox.restore();
	}
});

test("the Dropbox login is reused across tool calls instead of refreshed every time", async () => {
	const dropbox = withDropbox((url) =>
		url.includes("oauth2/token") ? tokenOk() : Response.json({ entries: [], has_more: false })
	);
	try {
		const env = makeEnv();
		const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_list", arguments: {} } };
		await rpc(env, call);
		await rpc(env, call);
		assert.equal(dropbox.calls.filter((u) => u.includes("oauth2/token")).length, 1);
	} finally {
		dropbox.restore();
	}
});

test("unreadable JSON is a parse error", async () => {
	const { status, json } = await rpc(makeEnv(), "{not json");
	assert.equal(status, 400);
	assert.equal(json.error.code, -32700);
});
