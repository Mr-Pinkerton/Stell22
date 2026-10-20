import { describe, expect, it } from "vitest";
import {
  classifyContainerInspect,
  containerRemovalResult,
  removalGate,
  volumeIdentityAccepted,
  writerIdentityAccepted,
  type DockerExec,
  type WriterInspectFields,
} from "@/server/internal/p1-offline-writer-admission/owned-resources";

const proofId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const containerId = "a".repeat(64);
const foreignId = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;
const containerName = "stell22-p1owa-app-aaaaaaaa";
const volumeName = "stell22-p1owa-vol-aaaaaaaa";
const networkName = "stell22-p1wc-net-aaaaaaaa";
const owned = { proofId, containerId, containerName, volumeName, imageId };

function fields(overrides: Partial<WriterInspectFields> = {}): WriterInspectFields {
  return {
    id: containerId,
    name: `/${containerName}`,
    image: "postgres:17-alpine",
    imageId,
    label: proofId,
    project: "",
    policy: "unless-stopped",
    running: "true",
    ports: "{}",
    networks: `${networkName} `,
    ...overrides,
  };
}

function gate(overrides: Partial<Parameters<typeof removalGate>[0]> = {}) {
  return removalGate({
    reconfirmOk: true,
    observedDaemonId: "daemon-a",
    expectedDaemonId: "daemon-a",
    observedEndpoint: "npipe:////./pipe/dockerDesktopLinuxEngine",
    expectedEndpoint: "npipe:////./pipe/dockerDesktopLinuxEngine",
    containerAccepted: true,
    ...overrides,
  });
}

function exec(overrides: Partial<DockerExec> = {}): DockerExec {
  return { status: 1, stdout: "", stderr: "", signal: null, errorCode: null, ...overrides };
}

describe("writer removal identity", () => {
  it("accepts only the full captured identity", () => {
    expect(writerIdentityAccepted(networkName, owned, fields(), false)).toBe(true);
  });

  it("rejects a foreign container id", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ id: foreignId }), false)).toBe(false);
    expect(gate({ containerAccepted: false })).toBe("preserve");
  });

  it("rejects a wrong container name even when the label matches", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ name: "/stell22-p1owa-app-other" }), false)).toBe(false);
  });

  it("rejects a wrong proof label even when the name matches", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ label: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), false)).toBe(false);
  });

  it("rejects a wrong image id", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ imageId: `sha256:${"d".repeat(64)}` }), false)).toBe(false);
  });

  it("rejects an unexpected Compose project", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ project: "stell22" }), false)).toBe(false);
  });

  it("rejects a wrong Docker network", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ networks: "bridge " }), false)).toBe(false);
  });

  it("rejects a wrong restart policy", () => {
    expect(writerIdentityAccepted(networkName, owned, fields({ policy: "always" }), false)).toBe(false);
  });

  it("does not accept a resource from its name alone or its label alone", () => {
    const nameOnly = fields({ id: foreignId, imageId: `sha256:${"d".repeat(64)}`, label: "other", networks: "bridge " });
    const labelOnly = fields({ id: foreignId, name: "/stell22-db", imageId: `sha256:${"d".repeat(64)}`, networks: "bridge " });
    expect(writerIdentityAccepted(networkName, owned, nameOnly, false)).toBe(false);
    expect(writerIdentityAccepted(networkName, owned, labelOnly, false)).toBe(false);
  });

  it("rejects a wrong volume label and a production volume name", () => {
    expect(volumeIdentityAccepted(volumeName, proofId, volumeName, "other-proof", "")).toBe(false);
    expect(volumeIdentityAccepted("stell22-db", proofId, "stell22-db", proofId, "")).toBe(false);
  });

  it("preserves the resource when the daemon or endpoint does not match", () => {
    expect(gate({ observedDaemonId: "daemon-b" })).toBe("preserve");
    expect(gate({ observedDaemonId: "" })).toBe("preserve");
    expect(gate({ observedEndpoint: "tcp://10.9.9.9:2375" })).toBe("preserve");
    expect(gate({ reconfirmOk: false })).toBe("preserve");
  });

  it("does not treat a failed removal as removed and does not continue to the volume", () => {
    expect(containerRemovalResult(1)).toBe("preserved");
    expect(containerRemovalResult(null)).toBe("preserved");
    expect(containerRemovalResult(0)).toBe("removed");
  });
});

describe("containerGone inspect classification", () => {
  it("confirms absence only when inspect names that exact id", () => {
    expect(classifyContainerInspect(containerId, exec({ stderr: `Error: No such object: ${containerId}` }))).toEqual({
      gone: true,
      reason: "absent",
    });
    expect(classifyContainerInspect(containerId, exec({ stderr: `Error response from daemon: No such container: ${containerId}` })).gone).toBe(true);
  });

  it("does not call a still-present container gone", () => {
    expect(classifyContainerInspect(containerId, exec({ status: 0, stdout: containerId }))).toEqual({ gone: false, reason: "present" });
  });

  it("does not call an uncertain inspect gone", () => {
    expect(classifyContainerInspect(containerId, exec({ stderr: `Error: No such object: ${foreignId}` })).reason).toBe("unknown");
    expect(classifyContainerInspect(containerId, exec({ stderr: "Cannot connect to the Docker daemon at npipe:////./pipe/dockerDesktopLinuxEngine" })).reason).toBe("daemon");
    expect(classifyContainerInspect(containerId, exec({ stderr: `error during connect: open //./pipe/dockerDesktopLinuxEngine` })).reason).toBe("daemon");
    expect(classifyContainerInspect(containerId, exec({ stderr: `context "desktop-linux" not found` })).reason).toBe("endpoint");
    expect(classifyContainerInspect(containerId, exec({ status: null, errorCode: "ENOENT" })).reason).toBe("cli");
    expect(classifyContainerInspect(containerId, exec({ stderr: "docker: command not found" })).reason).toBe("cli");
    expect(classifyContainerInspect(containerId, exec({ status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" })).reason).toBe("timeout");
    expect(classifyContainerInspect(containerId, exec({ status: null })).reason).toBe("unknown");
    expect(classifyContainerInspect(containerId, exec({ stderr: "permission denied" })).reason).toBe("unknown");
    for (const sample of [
      exec({ stderr: `Error: No such object: ${foreignId}` }),
      exec({ stderr: "Cannot connect to the Docker daemon" }),
      exec({ stderr: `context "desktop-linux" not found` }),
      exec({ status: null, errorCode: "ENOENT" }),
      exec({ status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" }),
      exec({ status: null }),
    ]) {
      expect(classifyContainerInspect(containerId, sample).gone).toBe(false);
    }
  });
});
