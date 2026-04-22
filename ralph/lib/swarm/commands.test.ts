import assert from "node:assert";
import { it } from "bun:test";
import { buildAutoCloseCommand } from "./commands.js";

it("builds a pane command that closes the pane after the timeout", () => {
	const command = buildAutoCloseCommand("echo hi", 30);

	assert.match(command, /^\(echo hi\); __omnidev_exit_code=\$\?/);
	assert.match(command, /echo "\[finished\]"/);
	assert.match(command, /tmux display-message -p '#\{pane_id\}'/);
	assert.match(command, /sleep 30;/);
	assert.match(command, /tmux kill-pane -t "\$__omnidev_pane_id"/);
	assert.match(command, /exit \$__omnidev_exit_code$/);
});
