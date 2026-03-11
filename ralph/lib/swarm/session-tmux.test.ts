import assert from "node:assert";
import { it } from "node:test";
import { TmuxSessionBackend } from "./session-tmux.js";

it("reuses the bootstrap pane on first createPane", async () => {
	const calls: string[][] = [];
	let panes = [
		{
			paneId: "%1",
			windowId: "@1",
			title: "",
			pid: "111",
		},
	];

	const execTmux = async (...args: string[]): Promise<{ stdout: string; stderr: string }> => {
		calls.push(args);
		const [command, ...rest] = args;

		if (command === "has-session") {
			throw new Error("can't find session");
		}

		if (command === "new-session") {
			return { stdout: "%1\n", stderr: "" };
		}

		if (command === "select-pane" && rest[2] === "-T") {
			const paneId = rest[1];
			const title = rest[3] ?? "";
			panes = panes.map((pane) => (pane.paneId === paneId ? { ...pane, title } : pane));
			return { stdout: "", stderr: "" };
		}

		if (command === "list-panes") {
			const stdout = panes
				.map((pane) => `${pane.paneId}\t${pane.windowId}\t${pane.title}\t${pane.pid}`)
				.join("\n");
			return { stdout, stderr: "" };
		}

		if (command === "send-keys") {
			return { stdout: "", stderr: "" };
		}

		if (command === "select-layout") {
			return { stdout: "", stderr: "" };
		}

		if (command === "display-message") {
			return { stdout: "@1\n", stderr: "" };
		}

		if (command === "list-windows") {
			return { stdout: "@1\t1\n", stderr: "" };
		}

		if (command === "split-window" || command === "new-window") {
			throw new Error(`unexpected ${command}`);
		}

		throw new Error(`unexpected tmux command: ${args.join(" ")}`);
	};

	const session = new TmuxSessionBackend(4, execTmux);
	const ensureResult = await session.ensureSession("ralph");
	assert.ok(ensureResult.ok);

	const paneResult = await session.createPane("ralph", {
		title: "my-prd",
		command: "omnidev ralph start my-prd",
	});

	assert.ok(paneResult.ok);
	assert.strictEqual(paneResult.data?.paneId, "%1");
	assert.strictEqual(paneResult.data?.windowId, "@1");

	assert.ok(
		calls.some((args) => args[0] === "send-keys" && args[3] === "omnidev ralph start my-prd"),
	);
	assert.ok(!calls.some((args) => args[0] === "split-window"));
	assert.ok(!calls.some((args) => args[0] === "new-window"));
});
