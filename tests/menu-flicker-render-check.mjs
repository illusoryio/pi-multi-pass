// Menu lifecycle check against the real pi renderer (INT-219).
//
// Runs the shipped createMenuUiScope()/showWrappedSelect() code on the real
// @earendil-works/pi-tui render pipeline (process.nextTick immediate render
// after key handling, throttled frames otherwise) plus a verbatim copy of the
// host's non-overlay custom-UI lifecycle from pi-coding-agent
// interactive-mode.js (showExtensionCustom -> restoreEditor).
//
// Skips when the pi packages are not installed. Point PI_MODULES_DIR at a
// node_modules directory containing @earendil-works/* to run it against an
// existing pi install.

import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function resolveModulesDir() {
	if (process.env.PI_MODULES_DIR) return resolve(process.env.PI_MODULES_DIR);
	try {
		const tuiUrl = import.meta.resolve("@earendil-works/pi-tui");
		const marker = `${join("node_modules", "@earendil-works")}`;
		const tuiPath = fileURLToPath(tuiUrl);
		const index = tuiPath.lastIndexOf(marker);
		if (index === -1) return undefined;
		return tuiPath.slice(0, index + "node_modules".length);
	} catch {
		return undefined;
	}
}

const modulesDir = await resolveModulesDir();
if (!modulesDir) {
	console.log("menu flicker render checks skipped (pi packages not installed)");
	process.exit(0);
}

const workdir = mkdtempSync(join(tmpdir(), "pi-multi-pass-render-"));
let exitCode = 0;
try {
	symlinkSync(modulesDir, join(workdir, "node_modules"), "dir");
	const extensionCopy = join(workdir, "multi-sub.ts");
	cpSync(join(root, "extensions", "multi-sub.ts"), extensionCopy);
	// Expose the private loader only in this disposable test copy.
	appendFileSync(extensionCopy, "\nexport { loadQuotaResults };\n");

	// Resolve the pi packages from the workdir so PI_MODULES_DIR installs work.
	const depsEntry = join(workdir, "deps.mjs");
	writeFileSync(
		depsEntry,
		'export * as tui from "@earendil-works/pi-tui";\nexport * as agent from "@earendil-works/pi-coding-agent";\n',
	);
	const deps = await import(pathToFileURL(depsEntry).href);
	const { Container, Text, TuiMainScreen } = deps.tui;
	const { initTheme, BorderedLoader } = deps.agent;
	const { createMenuUiScope, showWrappedSelect, loadQuotaResults } = await import(pathToFileURL(extensionCopy).href);

	initTheme("dark");
	const theme = { fg: (_color, value) => value, bold: (value) => value };
	const keybindings = { get: () => undefined };

	class FakeTerminal {
		columns = 80;
		rows = 24;
		kittyProtocolActive = false;
		start() {}
		stop() {}
		async drainInput() {}
		write() {}
		moveBy() {}
		hideCursor() {}
		showCursor() {}
		clearLine() {}
		clearFromCursor() {}
		clearScreen() {}
		setTitle() {}
		setProgress() {}
	}

	class RecordingTui extends TuiMainScreen {
		frames = [];
		render(width) {
			const lines = super.render(width);
			this.frames.push(lines.join("\n"));
			return lines;
		}
	}

	class FakeEditor {
		constructor(text) { this.text = text; }
		render() { return [`> ${this.text}`, "EDITOR-CHROME"]; }
		invalidate() {}
		handleInput() {}
		getText() { return this.text; }
		setText(value) { this.text = value; }
	}

	function createHost() {
		const tui = new RecordingTui(new FakeTerminal());
		const editor = new FakeEditor("draft message");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(new Text("chat transcript", 0, 0));
		tui.addChild(editorContainer);
		tui.setFocus(editor);
		tui.start();

		const state = { restores: 0, inputSlotStates: [] };

		// verbatim from interactive-mode.js showExtensionCustom (non-overlay)
		const custom = (factory) => {
			const savedText = editor.getText();
			const restoreEditor = () => {
				state.restores += 1;
				editorContainer.clear();
				editorContainer.addChild(editor);
				editor.setText(savedText);
				tui.setFocus(editor);
				tui.requestRender();
			};
			return new Promise((resolvePromise) => {
				let component;
				let closed = false;
				const close = (result) => {
					if (closed) return;
					closed = true;
					restoreEditor();
					resolvePromise(result);
					try { component?.dispose?.(); } catch { /* ignore */ }
				};
				Promise.resolve(factory(tui, theme, keybindings, close)).then((created) => {
					if (closed) return;
					component = created;
					editorContainer.clear();
					editorContainer.addChild(created);
					tui.setFocus(created);
					tui.requestRender();
				});
			});
		};

		const ctx = {
			cwd: workdir,
			hasUI: true,
			model: undefined,
			ui: {
				custom,
				notify: () => {},
				select: async () => undefined,
				confirm: async () => true,
				input: async () => {
					state.inputSlotStates.push(editorContainer.children[0] === editor ? "editor" : "component");
					return "typed";
				},
				theme,
			},
		};

		return { tui, editor, editorContainer, ctx, state };
	}

	const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
	// stdin data arrives in a macrotask; the frame it schedules on
	// process.nextTick runs before the extension's promise continuation
	const press = (tui, data) =>
		new Promise((r) => setTimeout(() => { tui.handleTerminalInput(data); r(); }, 0));

	const classify = (frame) => {
		if (frame.includes("MENU-ONE")) return "MENU-ONE";
		if (frame.includes("MENU-TWO")) return "MENU-TWO";
		if (frame.includes("EDITOR-CHROME")) return "EDITOR";
		return "OTHER";
	};

	const menu = (title) => ({
		title,
		items: [{ value: "a", label: `${title}-alpha` }, { value: "b", label: `${title}-beta` }],
		confirmHint: "open",
		cancelHint: "back",
	});

	async function measureChain(useSession) {
		const host = createHost();
		const scope = useSession
			? createMenuUiScope(host.ctx)
			: { ctx: host.ctx, close: async () => {} };
		const flow = (async () => {
			const first = await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
			if (!first) return undefined;
			return showWrappedSelect(scope.ctx, menu("MENU-TWO"));
		})().finally(() => scope.close());

		await settle(40);
		host.tui.frames.length = 0;
		await press(host.tui, "\r");
		await settle();

		const sequence = host.tui.frames.map(classify);
		const menuTwoAt = sequence.indexOf("MENU-TWO");
		const editorFrames = sequence
			.slice(0, menuTwoAt === -1 ? sequence.length : menuTwoAt)
			.filter((frame) => frame === "EDITOR").length;

		await press(host.tui, "\r");
		const result = await flow;
		await settle(40);
		host.tui.stop();

		return { editorFrames, sequence, result, host };
	}

	const baseline = await measureChain(false);
	assert.ok(
		baseline.editorFrames >= 1,
		`expected the editor to render between menus without a session, got ${JSON.stringify(baseline.sequence)}`,
	);

	const fixed = await measureChain(true);
	assert.equal(
		fixed.editorFrames,
		0,
		`unexpected editor frame between menus: ${JSON.stringify(fixed.sequence)}`,
	);
	assert.equal(fixed.result, "a");
	assert.equal(fixed.host.state.restores, 1, "editor should be restored exactly once per flow");
	assert.equal(fixed.host.editorContainer.children[0], fixed.host.editor);
	assert.equal(fixed.host.editor.getText(), "draft message");

	// Arrow navigation keeps the screen open and still moves the selection.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = showWrappedSelect(scope.ctx, menu("MENU-ONE")).finally(() => scope.close());
		await settle(40);
		host.tui.frames.length = 0;
		await press(host.tui, "\x1b[B");
		await settle(40);
		assert.ok(
			!host.tui.frames.map(classify).includes("EDITOR"),
			"arrow keys must not render the editor",
		);
		await press(host.tui, "\r");
		assert.equal(await flow, "b");
		await settle(20);
		host.tui.stop();
	}

	// Escape cancels and restores the editor exactly once.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = showWrappedSelect(scope.ctx, menu("MENU-ONE")).finally(() => scope.close());
		await settle(40);
		await press(host.tui, "\x1b");
		assert.equal(await flow, undefined);
		await settle(40);
		assert.equal(host.state.restores, 1);
		assert.equal(host.editorContainer.children[0], host.editor);
		assert.equal(host.editor.getText(), "draft message");
		host.tui.stop();
	}

	// menu -> ui.input -> menu: the prompt runs with the editor slot restored.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = (async () => {
			const first = await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
			const typed = await scope.ctx.ui.input("Label", "placeholder");
			const second = await showWrappedSelect(scope.ctx, menu("MENU-TWO"));
			return { first, typed, second };
		})().finally(() => scope.close());

		await settle(40);
		await press(host.tui, "\r");
		await settle();
		await press(host.tui, "\r");
		assert.deepEqual(await flow, { first: "a", typed: "typed", second: "a" });
		await settle(40);
		assert.deepEqual(host.state.inputSlotStates, ["editor"]);
		assert.equal(host.editorContainer.children[0], host.editor);
		host.tui.stop();
	}

	// Combined INT-218/219 boundary: the real BorderedLoader is a menu-session
	// child. Fake auth/fetch only; no stored credentials or provider calls.
	for (const cancel of [false, true]) {
		const host = createHost();
		host.ctx.modelRegistry = {
			getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: "fixture-token" } }),
		};
		const scope = createMenuUiScope(host.ctx);
		const originalFetch = globalThis.fetch;
		const originalDispose = BorderedLoader.prototype.dispose;
		let disposed = 0;
		let requestedSignal;
		let completeFetch;
		let started;
		const fetchStarted = new Promise((resolve) => { started = resolve; });
		globalThis.fetch = async (url, options) => {
			assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
			assert.equal(options.headers.Authorization, "Bearer fixture-token");
			requestedSignal = options.signal;
			started();
			return new Promise((resolve, reject) => {
				completeFetch = () => resolve(Response.json({
					five_hour: { utilization: 20, resets_at: "2026-10-01T12:00:00Z" },
					seven_day: { utilization: 30, resets_at: "2026-10-02T12:00:00Z" },
				}));
				options.signal.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true });
			});
		};
		BorderedLoader.prototype.dispose = function () { disposed++; originalDispose.call(this); };
		try {
			const flow = (async () => {
				await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
				const results = await loadQuotaResults(scope.ctx, [{
					providerName: "anthropic", baseProvider: "anthropic", displayName: "Fixture",
					auth: { type: "oauth", access: "fixture-old", expires: Date.now() + 60_000 },
				}]);
				await showWrappedSelect(scope.ctx, menu("MENU-TWO"));
				return results;
			})().finally(() => scope.close());
			await settle(40);
			host.tui.frames.length = 0;
			await press(host.tui, "\r");
			await fetchStarted;
			await settle(40);
			assert.ok(host.tui.frames.some((frame) => frame.includes("Checking limits across")));
			if (cancel) await press(host.tui, "\x1b");
			else completeFetch();
			await settle(40);
			assert.ok(host.tui.frames.some((frame) => frame.includes("MENU-TWO")));
			assert.ok(!host.tui.frames.some((frame) => frame.includes("EDITOR-CHROME")));
			assert.equal(disposed, 1, "loader must dispose when the next menu mounts");
			assert.equal(requestedSignal.aborted, cancel);
			await press(host.tui, "\x1b");
			const results = await flow;
			if (cancel) assert.equal(results, null);
			else assert.equal(results[0].score, 70);
			assert.equal(host.state.restores, 1);
			assert.equal(host.editorContainer.children[0], host.editor);
			assert.equal(host.editor.getText(), "draft message");
			console.log(`quota loader as menu child: ${cancel ? "cancel" : "complete"} passed; dispose=1, restores=1, intermediate editor frames=0`);
		} finally {
			await scope.close();
			host.tui.stop();
			globalThis.fetch = originalFetch;
			BorderedLoader.prototype.dispose = originalDispose;
		}
	}

	console.log(
		`menu flicker render checks passed (editor frames between menus — baseline: ${baseline.editorFrames}, with session: ${fixed.editorFrames})`,
	);
} catch (error) {
	exitCode = 1;
	console.error(error);
} finally {
	rmSync(workdir, { recursive: true, force: true });
	process.exit(exitCode);
}
