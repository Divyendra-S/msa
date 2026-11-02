import WindTunnelProbe
import XCTest

/// Outside a run, points and steps only run their code.
final class ProbeTests: XCTestCase {
    actor Counter {
        var value = 0

        func add() async throws -> Int {
            try await Probe.point("counter.add")
            return try await Probe.point("counter.store") {
                value += 1
                return value
            }
        }
    }

    func testPointsDoNothingOutsideARun() async throws {
        XCTAssertFalse(Probe.isActive)
        let counter = Counter()
        let value = try await Probe.step("add") { try await counter.add() }
        XCTAssertEqual(value, 1)
    }

    func testStepsPassErrorsOn() async {
        struct Boom: Error {}
        do {
            try await Probe.step("fail") { throw Boom() }
            XCTFail("the step should have thrown")
        } catch {
            XCTAssertTrue(error is Boom)
        }
    }
}
