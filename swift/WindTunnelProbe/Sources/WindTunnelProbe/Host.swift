import Foundation
#if DEBUG && os(macOS)
import AppKit
import ObjectiveC
#endif

extension Probe {
    /// Runs the run's scenario inside this app, in place of the app, when a Wind Tunnel run
    /// started it to; returns at once otherwise. Call it first thing in the app's entry point.
    ///
    /// An Xcode project's tests run inside its app (`TEST_HOST`). For each run, Wind Tunnel starts
    /// the app's own executable with the test bundle and the one test to run: this loads XCTest and
    /// the bundle, runs that test, and exits with its result, before the app has shown anything.
    /// `UserDefaults.standard` is then the run's own, in its data folder, not the app's real one.
    public static func hostScenario() {
        #if DEBUG && os(macOS)
        let env = ProcessInfo.processInfo.environment
        guard let test = env["WINDTUNNEL_SCENARIO"], let tests = env["WINDTUNNEL_TESTS"], let xctest = env["WINDTUNNEL_XCTEST"] else { return }
        let succeeded = MainActor.assumeIsolated { ScenarioHost.run(test: test, bundle: tests, xctest: xctest) }
        exit(succeeded ? 0 : 1)
        #endif
    }
}

#if DEBUG && os(macOS)
/// Runs one XCTest method in this process, as `xctest` would, through XCTest's Objective-C API:
/// the app links nothing of XCTest, which only exists inside Xcode.
@MainActor
enum ScenarioHost {
    static func run(test: String, bundle path: String, xctest: String) -> Bool {
        // No Dock icon, menu bar or window, whatever the code under test touches.
        NSApplication.shared.setActivationPolicy(.prohibited)
        useOwnDefaults()

        guard dlopen(xctest, RTLD_NOW) != nil else {
            return fail("can't load XCTest from \(xctest): \(String(cString: dlerror()))")
        }
        guard let bundle = Bundle(path: path) else { return fail("no test bundle at \(path)") }
        do {
            try bundle.loadAndReturnError()
        } catch {
            return fail("can't load \(path): \(error)")
        }
        // `Module.Class/testMethod`; a test that isn't there makes an empty suite, which runs none.
        guard let suiteClass = NSClassFromString("XCTestSuite") as AnyObject?,
              let suite = suiteClass.perform(NSSelectorFromString("testSuiteForTestCaseWithName:"), with: test)?.takeUnretainedValue()
        else {
            return fail("XCTest has no XCTestSuite")
        }
        _ = suite.perform(NSSelectorFromString("runTest"))
        let run = suite.value(forKey: "testRun") as AnyObject?
        lingerWhileHeld()
        return (run?.value(forKey: "hasSucceeded") as? Bool) ?? false
    }

    /// The app would keep running after the user's last action: while the run still holds a point
    /// (work the test didn't wait for, delayed or at a race), and a moment after, so the code past
    /// it runs before the app exits.
    private static func lingerWhileHeld() {
        guard let harness = Harness.shared, harness.isHolding else { return }
        let deadline = Date(timeIntervalSinceNow: 60)
        while harness.isHolding, Date() < deadline {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 1))
    }

    /// Points `UserDefaults.standard` at a file in the run's data folder. Setting the home folder
    /// doesn't move preferences: without this, the scenario would read and write the app's real
    /// settings.
    private static func useOwnDefaults() {
        let folder = Probe.dataDirectory.appendingPathComponent("Library/Preferences", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // A suite named by a path is kept at that path (plus `.plist`), not in ~/Library/Preferences.
        let name = folder.appendingPathComponent(Bundle.main.bundleIdentifier ?? "app").path
        guard let defaults = UserDefaults(suiteName: name),
              let method = class_getClassMethod(UserDefaults.self, NSSelectorFromString("standardUserDefaults"))
        else {
            return
        }
        let standard: @convention(block) (AnyObject) -> UserDefaults = { _ in defaults }
        method_setImplementation(method, imp_implementationWithBlock(standard))
    }

    private static func fail(_ message: String) -> Bool {
        FileHandle.standardError.write(Data("WindTunnelProbe: \(message)\n".utf8))
        return false
    }
}
#endif
