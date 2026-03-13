import { describe, expect, it } from "vitest";
import { buildDockerExecArgs } from "./bash-tools.shared.js";

describe("buildDockerExecArgs", () => {
  it("prepends custom PATH after login shell sourcing to preserve both custom and system tools", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: "/custom/bin:/usr/local/bin:/usr/bin",
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain("OPENCLAW_PREPEND_PATH=/custom/bin:/usr/local/bin:/usr/bin");
    expect(commandArg).toContain('export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"');
    expect(commandArg).toContain("echo hello");
    expect(commandArg).toBe(
      'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; echo hello',
    );
  });

  it("does not interpolate PATH into the shell command", () => {
    const injectedPath = "$(touch /tmp/openclaw-path-injection)";
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: injectedPath,
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain(`OPENCLAW_PREPEND_PATH=${injectedPath}`);
    expect(commandArg).not.toContain(injectedPath);
    expect(commandArg).toContain("OPENCLAW_PREPEND_PATH");
  });

  it("does not add PATH export when PATH is not in env", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toBe("echo hello");
    expect(commandArg).not.toContain("export PATH");
  });

  it("includes workdir flag when specified", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "pwd",
      workdir: "/workspace",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
  });

  it("uses login shell for consistent environment", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo test",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("/bin/sh");
    expect(args).toContain("-lc");
  });

  it("includes tty flag when requested", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "bash",
      env: { HOME: "/home/user" },
      tty: true,
    });

    expect(args).toContain("-t");
  });

  it("inserts -u flag when user is provided", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {},
      tty: false,
      user: "1000:1000",
    });
    const uIndex = args.indexOf("-u");
    expect(uIndex).toBeGreaterThan(0);
    expect(args[uIndex + 1]).toBe("1000:1000");
    const containerIndex = args.indexOf("test-container");
    expect(uIndex).toBeLessThan(containerIndex);
  });

  it("does not insert -u flag when user is undefined", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {},
      tty: false,
      user: undefined,
    });
    expect(args).not.toContain("-u");
  });

  it("does not insert -u flag when user is empty string", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {},
      tty: false,
      user: "",
    });
    expect(args).not.toContain("-u");
  });

  it("places -u before -t when both user and tty are set", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {},
      tty: true,
      user: "1000:1000",
    });
    const uIndex = args.indexOf("-u");
    const tIndex = args.indexOf("-t");
    expect(uIndex).toBeGreaterThan(0);
    expect(tIndex).toBeGreaterThan(0);
    expect(uIndex).toBeLessThan(tIndex);
  });
});
