import { describe, expect, test } from "bun:test";
import { assertRemoteCheckDirectory, remoteCheckConfig } from "./remote-check";

describe("remote test dispatcher", () => {
  test("accepts an opaque SSH host alias", () => {
    expect(remoteCheckConfig(["--host", "m1-worker"])).toEqual({ host: "m1-worker" });
  });

  test("rejects incomplete or shell-shaped host input", () => {
    expect(() => remoteCheckConfig([])).toThrow("usage:");
    expect(() => remoteCheckConfig(["--host", "m1-worker; reboot"]))
      .toThrow("opaque host alias");
  });

  test("allows cleanup only inside a unique OmpClaw test directory", () => {
    expect(assertRemoteCheckDirectory("/tmp/ompclaw-check.Abc123"))
      .toBe("/tmp/ompclaw-check.Abc123");
    expect(() => assertRemoteCheckDirectory("/tmp/ompclaw-check"))
      .toThrow("refusing unsafe remote test directory");
    expect(() => assertRemoteCheckDirectory("/srv/test/ompclaw"))
      .toThrow("refusing unsafe remote test directory");
  });
});
