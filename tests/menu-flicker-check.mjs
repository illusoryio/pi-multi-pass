// Menu lifecycle checks: chained menu screens must not restore the chat editor
// between screens.
//
// The extension is imported for real (Node type stripping) against minimal
// stubs for the pi packages, so the assertions run the shipped
// createMenuUiScope()/showWrappedSelect() code rather than a copy of it.
//
// The host model below mirrors the pi TUI host:
//   * ui.custom (non-overlay) puts the component in the editor slot and, on
//     done(), synchronously restores the editor
//     (pi-coding-agent interactive-mode.js showExtensionCustom).
//   * key handling schedules the resulting frame with process.nextTick, which
//     Node drains before promise continuations (pi-tui tui.js
//     handleTerminalInput -> requestImmediateRender).
//   * ui.select/confirm/input/editor take over the same editor slot
//     (showExtensionSelector / showExtensionInput / showExtensionEditor).
//
// tests/menu-flicker-render-check.mjs runs the same scenarios against the real
// pi-tui renderer when the pi packages are installed.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workdir = mkdtempSync(join(tmpdir(), "pi-multi-pass-menu-"));

function writeStub(specifier, source) {
	const dir = join(workdir, "node_modules", specifier);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: specifier, type: "module", main: "index.js" }));
	writeFileSync(join(dir, "index.js"), source);
}

try {
	writeStub(
		"@earendil-works/pi-coding-agent",
		`export class BorderedLoader { constructor() { this.onAbort = undefined; } get signal() { return new AbortController().signal; } render() { return ["loader"]; } invalidate() {} handleInput() {} }
export class DynamicBorder { constructor(fn) { this.fn = fn; } render() { return ["---"]; } invalidate() {} }
export function getAgentDir() { return ${JSON.stringify(workdir)}; }
export function keyHint(_id, label) { return label; }
export function readStoredCredential() { return undefined; }
`,
	);
	writeStub(
		"@earendil-works/pi-ai",
		"export default {};\n",
	);
	mkdirSync(join(workdir, "node_modules", "@earendil-works", "pi-ai", "providers"), { recursive: true });
	writeFileSync(
		join(workdir, "node_modules", "@earendil-works", "pi-ai", "providers", "all.js"),
		"export function builtinProviders() { return []; }\nexport function getBuiltinModels() { return []; }\n",
	);
	writeFileSync(
		join(workdir, "node_modules", "@earendil-works", "pi-ai", "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-ai",
			type: "module",
			exports: { ".": "./index.js", "./providers/all": "./providers/all.js", "./oauth": "./index.js" },
		}),
	);
	writeStub(
		"@earendil-works/pi-tui",
		`export class Container {
	constructor() { this.children = []; }
	addChild(child) { this.children.push(child); }
	clear() { this.children = []; }
	render(width) { return this.children.flatMap((child) => child.render(width)); }
	invalidate() { for (const child of this.children) child.invalidate?.(); }
}
export class Text {
	constructor(text) { this.text = text; }
	render() { return [String(this.text)]; }
	invalidate() {}
}
export class SelectList {
	constructor(items) { this.items = items; this.index = 0; this.onSelect = undefined; this.onCancel = undefined; }
	setSelectedIndex(index) { this.index = index; }
	getSelectedItem() { return this.items[this.index]; }
	render() { return this.items.map((item, i) => (i === this.index ? "> " : "  ") + item.label); }
	invalidate() {}
	handleInput(data) {
		if (data === "\\r") { this.onSelect?.(this.items[this.index]); return; }
		if (data === "\\x1b") { this.onCancel?.(); return; }
		if (data === "down") { this.index = Math.min(this.index + 1, this.items.length - 1); return; }
		if (data === "up") { this.index = Math.max(this.index - 1, 0); }
	}
}
export const Key = { up: "up", down: "down", enter: "\\r", escape: "\\x1b" };
export function matchesKey(data, key) { return data === key; }
`,
	);

	const extensionCopy = join(workdir, "multi-sub.ts");
	cpSync(join(root, "extensions", "multi-sub.ts"), extensionCopy);
	const { createMenuUiScope, showWrappedSelect } = await import(pathToFileURL(extensionCopy).href);

	// ---------------------------------------------------------------- host model
	const EDITOR = { kind: "editor", label: "EDITOR", text: "draft message" };

	function createHost() {
		const state = {
			slot: EDITOR,
			focus: EDITOR,
			frames: [],
			restores: 0,
			editorText: "draft message",
			renderScheduled: false,
			notifications: [],
			inputSlotStates: [],
			overlayCalls: 0,
		};

		const requestRender = () => {
			if (state.renderScheduled) return;
			state.renderScheduled = true;
			process.nextTick(() => {
				state.renderScheduled = false;
				state.frames.push(state.slot === EDITOR ? "EDITOR" : (state.slot.label ?? "COMPONENT"));
			});
		};

		// verbatim structure of interactive-mode.js showExtensionCustom (non-overlay)
		const custom = (factory, options) => {
			if (options?.overlay) {
				state.overlayCalls += 1;
				return new Promise((resolve) => {
					const component = factory({ requestRender }, theme, keybindings, resolve);
					component.render?.(80);
				});
			}
			const savedText = state.editorText;
			const restoreEditor = () => {
				state.restores += 1;
				state.slot = EDITOR;
				state.editorText = savedText;
				state.focus = EDITOR;
				requestRender();
			};
			return new Promise((resolve) => {
				let component;
				let closed = false;
				const close = (result) => {
					if (closed) return;
					closed = true;
					restoreEditor();
					resolve(result);
					component?.dispose?.();
				};
				Promise.resolve(factory({ requestRender }, theme, keybindings, close)).then((created) => {
					if (closed) return;
					component = created;
					state.slot = created;
					state.focus = created;
					requestRender();
				});
			});
		};

		const takeOverEditorSlot = (label) => {
			state.inputSlotStates.push(state.slot === EDITOR ? "editor" : "component");
			state.slot = { kind: "prompt", label };
			return Promise.resolve().then(() => {
				state.slot = EDITOR;
				requestRender();
			});
		};

		const ctx = {
			cwd: workdir,
			hasUI: true,
			model: undefined,
			ui: {
				custom,
				notify: (message, type) => state.notifications.push([type, message]),
				select: async () => { await takeOverEditorSlot("SELECT"); return undefined; },
				confirm: async () => { await takeOverEditorSlot("CONFIRM"); return true; },
				input: async () => { await takeOverEditorSlot("INPUT"); return "typed"; },
				editor: async () => { await takeOverEditorSlot("EDITOR-PROMPT"); return undefined; },
				theme,
			},
		};

		// keyboard input arrives in a stdin macrotask, then the frame is
		// scheduled on process.nextTick (before promise continuations)
		const press = (data) =>
			new Promise((resolve) => {
				setTimeout(() => {
					state.focus?.handleInput?.(data);
					requestRender();
					resolve();
				}, 0);
			});

		return { state, ctx, press };
	}

	const theme = { fg: (_color, value) => value, bold: (value) => value };
	const keybindings = { get: () => undefined };
	const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

	const menu = (title) => ({
		title,
		items: [{ value: "a", label: `${title}-alpha` }, { value: "b", label: `${title}-beta` }],
		confirmHint: "open",
		cancelHint: "back",
	});

	const framesBetween = (frames, target) => {
		const at = frames.indexOf(target);
		return frames.slice(0, at === -1 ? frames.length : at).filter((frame) => frame === "EDITOR").length;
	};

	// 1. Baseline: one ui.custom per menu restores the editor between screens.
	{
		const host = createHost();
		const flow = (async () => {
			const first = await showWrappedSelect(host.ctx, menu("MENU-ONE"));
			assert.equal(first, "a");
			return showWrappedSelect(host.ctx, menu("MENU-TWO"));
		})();
		await settle();
		host.state.frames.length = 0;
		await host.press("\r");
		await settle();
		assert.ok(
			framesBetween(host.state.frames, "MENU-TWO") >= 1,
			`expected an editor frame between menus without a session, got ${JSON.stringify(host.state.frames)}`,
		);
		await host.press("\r");
		await flow;
	}

	// 2. Menu session: no editor frame between chained menus, editor restored once.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = (async () => {
			const first = await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
			assert.equal(first, "a");
			return showWrappedSelect(scope.ctx, menu("MENU-TWO"));
		})().finally(() => scope.close());

		await settle();
		host.state.frames.length = 0;
		await host.press("\r");
		await settle();
		assert.equal(
			framesBetween(host.state.frames, "MENU-TWO"),
			0,
			`unexpected editor frame between menus: ${JSON.stringify(host.state.frames)}`,
		);

		await host.press("\r");
		assert.equal(await flow, "a");
		await settle();
		assert.equal(host.state.restores, 1, "editor should be restored exactly once per flow");
		assert.equal(host.state.slot, EDITOR, "editor must own the slot after the flow");
		assert.equal(host.state.editorText, "draft message", "editor text must survive the flow");
	}

	// 3. Arrow navigation still moves the selection and never closes a screen.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = showWrappedSelect(scope.ctx, menu("MENU-ONE")).finally(() => scope.close());
		await settle();
		host.state.frames.length = 0;
		await host.press("down");
		await settle();
		assert.ok(!host.state.frames.includes("EDITOR"), "arrow keys must not restore the editor");
		assert.equal(host.state.restores, 0, "arrow keys must not close the screen");
		await host.press("\r");
		assert.equal(await flow, "b", "arrow navigation must change the selected value");
	}

	// 4. Escape cancels the screen and returns the editor.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = showWrappedSelect(scope.ctx, menu("MENU-ONE")).finally(() => scope.close());
		await settle();
		await host.press("\x1b");
		assert.equal(await flow, undefined, "escape must cancel the menu");
		await settle();
		assert.equal(host.state.slot, EDITOR);
		assert.equal(host.state.restores, 1);
	}

	// 5. Wrap-around selection is preserved (up on first item -> last item).
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = showWrappedSelect(scope.ctx, menu("MENU-ONE")).finally(() => scope.close());
		await settle();
		await host.press("up");
		await host.press("\r");
		assert.equal(await flow, "b", "up on the first item must wrap to the last item");
	}

	// 6. Editor-slot prompts (input) close the session first, then menus resume.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = (async () => {
			const first = await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
			const typed = await scope.ctx.ui.input("Label", "placeholder");
			const second = await showWrappedSelect(scope.ctx, menu("MENU-TWO"));
			return { first, typed, second };
		})().finally(() => scope.close());

		await settle();
		await host.press("\r");
		await settle();
		await host.press("\r");
		const result = await flow;
		await settle();
		assert.deepEqual(result, { first: "a", typed: "typed", second: "a" });
		assert.deepEqual(host.state.inputSlotStates, ["editor"], "ui.input must run with the editor restored");
		assert.equal(host.state.slot, EDITOR);
	}

	// 7. Notifications are delivered during a session and the flow still ends clean.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const flow = (async () => {
			await showWrappedSelect(scope.ctx, menu("MENU-ONE"));
			scope.ctx.ui.notify("hello", "info");
			await showWrappedSelect(scope.ctx, menu("MENU-TWO"));
		})().finally(() => scope.close());
		await settle();
		await host.press("\r");
		await settle();
		await host.press("\r");
		await flow;
		await settle();
		assert.deepEqual(host.state.notifications, [["info", "hello"]]);
		assert.equal(host.state.slot, EDITOR);
	}

	// 8. Overlay components bypass the session and reach the host unchanged.
	{
		const host = createHost();
		const scope = createMenuUiScope(host.ctx);
		const value = await scope.ctx.ui.custom(
			(_tui, _theme, _kb, done) => {
				done("overlay-result");
				return { render: () => ["overlay"], invalidate: () => {} };
			},
			{ overlay: true },
		);
		await scope.close();
		assert.equal(value, "overlay-result");
		assert.equal(host.state.overlayCalls, 1, "overlay requests must go straight to the host");
	}

	// 9. Non-UI contexts are passed through untouched.
	{
		const headless = { cwd: workdir, hasUI: false, ui: { custom: async () => "unused" } };
		const scope = createMenuUiScope(headless);
		assert.equal(scope.ctx, headless, "headless contexts must not be proxied");
		await scope.close();
	}

	// 10. Command handlers run their flows inside a menu session.
	{
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(join(root, "extensions", "multi-sub.ts"), "utf8"),
		);
		const wrapped = source.match(/withMenuUi\(hostCtx, async \(ctx\) => \{/g) ?? [];
		assert.equal(wrapped.length, 3, "all three commands must run inside a menu session");
		assert.doesNotMatch(
			source,
			/handler: async \(args: string, ctx: ExtensionCommandContext\)/,
			"command handlers must receive the session-scoped context",
		);
	}

	console.log("menu flicker checks passed");
} finally {
	rmSync(workdir, { recursive: true, force: true });
}
