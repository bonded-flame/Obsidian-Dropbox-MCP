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

test("vault_list follows Dropbox's continuation so large folders come back whole", async () => {
	const entry = (name: string) => ({ name, ".tag": "file", path_display: `/The Vault/${name}` });
	const dropbox = withDropbox((url) => {
		if (url.includes("oauth2/token")) return tokenOk();
		if (url.endsWith("files/list_folder")) return Response.json({ entries: [entry("a.md")], has_more: true, cursor: "c1" });
		if (url.endsWith("files/list_folder/continue")) return Response.json({ entries: [entry("b.md")], has_more: false, cursor: "c2" });
		throw new Error(`unexpected ${url}`);
	});
	try {
		const { json } = await rpc(makeEnv(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_list", arguments: {} } });
		const names = JSON.parse(json.result.content[0].text).map((e: { name: string }) => e.name);
		assert.deepEqual(names, ["a.md", "b.md"]);
	} finally {
		dropbox.restore();
	}
});

function editDropbox(fileContent: string, uploadResponse = () => Response.json({ rev: "r2" })) {
	const uploads: { arg: any; body: string }[] = [];
	const dropbox = withDropbox((url, init) => {
		if (url.includes("oauth2/token")) return tokenOk();
		if (url.endsWith("files/download")) {
			return new Response(fileContent, { headers: { "Dropbox-API-Result": JSON.stringify({ rev: "r1" }) } });
		}
		if (url.endsWith("files/upload")) {
			const headers = new Headers(init.headers);
			uploads.push({ arg: JSON.parse(headers.get("Dropbox-API-Arg") ?? "{}"), body: String(init.body) });
			return uploadResponse();
		}
		throw new Error(`unexpected ${url}`);
	});
	return { uploads, restore: dropbox.restore };
}

const editCall = (old_text: string, new_text: string) => ({
	jsonrpc: "2.0",
	id: 9,
	method: "tools/call",
	params: { name: "vault_edit", arguments: { path: "notes.md", old_text, new_text } },
});

test("vault_edit replaces the text and saves only on top of the version it read", async () => {
	const dropbox = editDropbox("# Notes\nold line\nkeep this\n");
	try {
		const { json } = await rpc(makeEnv(), editCall("old line", "new line"));
		assert.equal(json.result.isError, undefined);
		assert.equal(dropbox.uploads.length, 1);
		assert.equal(dropbox.uploads[0].body, "# Notes\nnew line\nkeep this\n");
		assert.deepEqual(dropbox.uploads[0].arg.mode, { ".tag": "update", update: "r1" });
	} finally {
		dropbox.restore();
	}
});

test("vault_edit refuses when the text is not in the file, and saves nothing", async () => {
	const dropbox = editDropbox("# Notes\nsomeone else changed this\n");
	try {
		const { json } = await rpc(makeEnv(), editCall("old line", "new line"));
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /not found/i);
		assert.equal(dropbox.uploads.length, 0);
	} finally {
		dropbox.restore();
	}
});

test("vault_edit refuses when the text appears more than once, and saves nothing", async () => {
	const dropbox = editDropbox("same\nsame\n");
	try {
		const { json } = await rpc(makeEnv(), editCall("same", "different"));
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /2 times/);
		assert.equal(dropbox.uploads.length, 0);
	} finally {
		dropbox.restore();
	}
});

test("vault_edit refuses empty old_text", async () => {
	const dropbox = editDropbox("anything");
	try {
		const { json } = await rpc(makeEnv(), editCall("", "x"));
		assert.equal(json.result.isError, true);
		assert.equal(dropbox.uploads.length, 0);
	} finally {
		dropbox.restore();
	}
});

test("vault_edit reports a conflict when the file changed between read and save", async () => {
	const dropbox = editDropbox("old line", () =>
		new Response('{"error_summary":"path/conflict/file/"}', { status: 409 })
	);
	try {
		const { json } = await rpc(makeEnv(), editCall("old line", "new line"));
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /changed while/i);
	} finally {
		dropbox.restore();
	}
});

test("vault_read still returns the plain file content", async () => {
	const dropbox = editDropbox("plain content");
	try {
		const { json } = await rpc(makeEnv(), { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault_read", arguments: { path: "notes.md" } } });
		assert.equal(json.result.content[0].text, "plain content");
	} finally {
		dropbox.restore();
	}
});

test("vault_edit refuses to save without Dropbox's version tag, so protection can never be skipped", async () => {
	const uploads: string[] = [];
	const dropbox = withDropbox((url) => {
		if (url.includes("oauth2/token")) return tokenOk();
		if (url.endsWith("files/download")) return new Response("old line");
		uploads.push(url);
		return Response.json({});
	});
	try {
		const { json } = await rpc(makeEnv(), editCall("old line", "new line"));
		assert.equal(json.result.isError, true);
		assert.equal(uploads.length, 0);
	} finally {
		dropbox.restore();
	}
});

test("a 409 that is not a revision conflict is not reported as 'the file changed'", async () => {
	const dropbox = editDropbox("old line", () =>
		new Response(JSON.stringify({ error_summary: "path/insufficient_space/..", error: { ".tag": "path" } }), { status: 409 })
	);
	try {
		const { json } = await rpc(makeEnv(), editCall("old line", "new line"));
		assert.equal(json.result.isError, true);
		assert.doesNotMatch(json.result.content[0].text, /changed while/i);
		assert.match(json.result.content[0].text, /insufficient_space/);
	} finally {
		dropbox.restore();
	}
});

test("an error page from Dropbox's login service is reported with its status, not a JSON parse error", async () => {
	const dropbox = withDropbox(() => new Response("<html>Bad gateway</html>", { status: 502 }));
	try {
		const { json } = await rpc(makeEnv(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_list", arguments: {} } });
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /Token refresh failed \(502\)/);
	} finally {
		dropbox.restore();
	}
});

test("a login Dropbox expired early is dropped and the call retried once with a fresh login", async () => {
	let tokenCalls = 0;
	let listCalls = 0;
	const dropbox = withDropbox((url, init) => {
		if (url.includes("oauth2/token")) {
			tokenCalls += 1;
			return Response.json({ access_token: `access-${tokenCalls}`, expires_in: 14400 });
		}
		listCalls += 1;
		const auth = new Headers(init.headers).get("Authorization");
		if (auth === "Bearer access-1") {
			return new Response(JSON.stringify({ error_summary: "expired_access_token/", error: { ".tag": "expired_access_token" } }), { status: 401 });
		}
		return Response.json({ entries: [], has_more: false });
	});
	try {
		const env = makeEnv();
		const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_list", arguments: {} } };
		const { json } = await rpc(env, call);
		assert.equal(json.result.isError, undefined);
		assert.equal(tokenCalls, 2);
		assert.equal(listCalls, 2);
		await rpc(env, call);
		assert.equal(tokenCalls, 2, "the fresh login is reused afterwards");
	} finally {
		dropbox.restore();
	}
});

test("vault_edit counts overlapping matches as ambiguous", async () => {
	const dropbox = editDropbox("aaa");
	try {
		const { json } = await rpc(makeEnv(), editCall("aa", "b"));
		assert.equal(json.result.isError, true);
		assert.match(json.result.content[0].text, /2 times/);
		assert.equal(dropbox.uploads.length, 0);
	} finally {
		dropbox.restore();
	}
});
