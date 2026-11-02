// Reading a Swift Mac app's code: its probe points, where more could go, and its scenarios.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findMacApp } from "../src/mac.ts";

const WRITER = `import Foundation
import WindTunnelProbe

enum WriterError: Error { case closed }

actor Writer {
    private let handle: FileHandle

    init(url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
    }

    /// Waits for the encoder, then writes.
    func append(_ data: Data) async throws {
        try await Probe.point("writer.append")
        try handle.write(contentsOf: data)
    }

    func finish() async throws {
        try Task.checkCancellation()
        try handle.write(contentsOf: Data("END".utf8))
        try handle.write(contentsOf: Data("\\n".utf8))
    }
}

final class Counter: @unchecked Sendable {
    var n = 0
    let queue = DispatchQueue(label: "counter")

    func bump() {
        queue.async { self.n += 1 }
        Task.detached { print("{ not a brace") }
    }
}
`;

const SCENARIOS = `import WindTunnelProbe
import XCTest

final class WriterScenarios: XCTestCase {
    func testWrite() async throws {
        try await Probe.step("write") {}
        try await Probe.step("finish") {}
    }

    func helper() {}
}
`;

describe("findMacApp", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-mac-"));
    const files: Record<string, string> = {
      "Package.swift": "// swift-tools-version: 6.0\n",
      "Sources/Writer/Writer.swift": WRITER,
      "Tests/WriterScenarios/WriterScenarios.swift": SCENARIOS,
      ".build/checkouts/Other/Other.swift": "actor Elsewhere {}\n",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists its probe points, with the function each is in and the comment above it", async () => {
    const app = await findMacApp(root);
    assert.equal(app?.framework, "Swift (Mac)");
    assert.deepEqual(app!.points, [
      { name: "writer.append", file: "Sources/Writer/Writer.swift", line: 16, section: false, in: "Writer.append", comment: "Waits for the encoder, then writes." },
    ]);
  });

  it("lists where more could go: actors, tasks, queues, shared state, file writes, cancellation checks", async () => {
    const app = await findMacApp(root);
    assert.deepEqual(
      app!.sites.map((s) => `${s.kind} ${s.lines.join(",")}${s.in ? ` in ${s.in}` : ""}${s.probed ? " *" : ""}`),
      [
        "actor 6",
        "file write 10,11 in Writer.init",
        "file write 17 in Writer.append *",
        "cancellation 21 in Writer.finish",
        "file write 22,23 in Writer.finish",
        "unchecked shared state 27",
        "dispatch queue 29 in Counter",
        "dispatch queue 32 in Counter.bump",
        "detached task 33 in Counter.bump",
      ],
    );
  });

  it("lists the XCTest methods a scenario can name, with their steps", async () => {
    const app = await findMacApp(root);
    assert.deepEqual(app!.scenarios, [{ id: "WriterScenarios/testWrite", file: "Tests/WriterScenarios/WriterScenarios.swift", line: 5, steps: ["write", "finish"] }]);
  });

  it("is no Mac app without a Package.swift", async () => {
    assert.equal(await findMacApp(join(root, "Sources")), undefined);
  });
});
