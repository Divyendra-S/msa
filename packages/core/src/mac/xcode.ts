import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { MacConfig } from "../config.ts";
import type { Sanitizer } from "./sanitizer.ts";

const run = promisify(execFile);

/**
 * An Xcode project's tests, as its build left them: each bundle runs inside its app, which the
 * run starts itself, with what XCTest needs to load.
 */
export interface HostedTests {
  /** The test target's module: `RecoTests`. */
  module: string;
  bundle: string;
  /** The app's executable, which runs the scenario through `Probe.hostScenario()`. */
  executable: string;
  /** XCTest's own library, which the app loads. */
  xctest: string;
  /** Where the bundle's frameworks and XCTest's are found (`DYLD_FRAMEWORK_PATH`, `DYLD_LIBRARY_PATH`). */
  env: Record<string, string>;
}

/**
 * Where a version's Xcode build goes: outside the repository, in /tmp, where macOS doesn't
 * register the apps it finds (a second copy of an app elsewhere can take its links and its
 * permissions).
 */
export function derivedDataDir(projectKey: string, versionId: string, sanitizer: Sanitizer): string {
  return join("/tmp", `windtunnel-${userInfo().uid}`, projectKey, `${versionId}-${sanitizer}`);
}

/**
 * Builds the app and its tests for running, ad-hoc signed: a run never needs the team's
 * certificate, and the Mac may have none. Without the hardened runtime, the app can load XCTest.
 */
export function xcodeBuildCommand(mac: MacConfig, sanitizer: Sanitizer): string {
  const project = mac.project!.replace(/\/$/, "");
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return [
    "xcodebuild",
    project.endsWith(".xcworkspace") ? "-workspace" : "-project",
    quote(project),
    "-scheme",
    quote(mac.scheme!),
    "-configuration Debug",
    `-destination 'platform=macOS,arch=${arch}'`,
    '-derivedDataPath "$DERIVED_DATA"',
    ...(sanitizer === "thread" ? ["-enableThreadSanitizer YES"] : []),
    "build-for-testing -quiet",
    "CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=",
    "ENABLE_HARDENED_RUNTIME=NO",
  ].join(" ");
}

/** The app-hosted test bundles a build left, read from its `.xctestrun`. */
export async function hostedTests(derivedData: string): Promise<HostedTests[]> {
  const products = join(derivedData, "Build", "Products");
  const runs = (await readdir(products).catch(() => [])).filter((f) => f.endsWith(".xctestrun"));
  if (runs.length === 0) throw new Error(`the build left no .xctestrun in ${products}`);
  const file = join(products, runs.sort().at(-1)!);
  const plist = JSON.parse((await run("plutil", ["-convert", "json", "-o", "-", file])).stdout) as Record<string, unknown>;
  const developer = (await run("xcode-select", ["-p"])).stdout.trim();
  const platform = join(developer, "Platforms", "MacOSX.platform", "Developer");
  const targets = xctestrunTargets(plist);
  const out: HostedTests[] = [];
  for (const target of targets) {
    if (!target.IsAppHostedTestBundle || target.IsUITestBundle || !target.TestHostPath || !target.TestBundlePath) continue;
    const places: Record<string, string> = {
      __TESTROOT__: dirname(file),
      __PLATFORMS__: join(developer, "Platforms"),
      __SHAREDFRAMEWORKS__: join(developer, "..", "SharedFrameworks"),
      __DEVELOPERUSRLIB__: join(developer, "usr", "lib"),
      __DERIVEDDATA__: derivedData,
    };
    const resolve = (path: string) => path.replace(/__[A-Z]+__/g, (m) => places[m] ?? m);
    const host = resolve(target.TestHostPath);
    places.__TESTHOST__ = host;
    const name = (await run("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(host, "Contents", "Info.plist")])).stdout.trim();
    const testing = target.TestingEnvironmentVariables ?? {};
    const paths = (key: string, extra: string[]) => [...(testing[key] ? resolve(testing[key]).split(":") : []), ...extra].filter(Boolean).join(":");
    out.push({
      module: target.ProductModuleName ?? target.BlueprintName ?? "",
      bundle: resolve(target.TestBundlePath),
      executable: join(host, "Contents", "MacOS", name),
      xctest: join(platform, "Library", "Frameworks", "XCTest.framework", "XCTest"),
      env: {
        // XCTest's own frameworks, and the build's (package frameworks, embedded ones).
        DYLD_FRAMEWORK_PATH: paths("DYLD_FRAMEWORK_PATH", [join(platform, "Library", "Frameworks"), join(platform, "Library", "PrivateFrameworks")]),
        DYLD_LIBRARY_PATH: paths("DYLD_LIBRARY_PATH", [join(platform, "usr", "lib")]),
      },
    });
  }
  return out;
}

interface XctestrunTarget {
  BlueprintName?: string;
  ProductModuleName?: string;
  IsAppHostedTestBundle?: boolean;
  IsUITestBundle?: boolean;
  TestHostPath?: string;
  TestBundlePath?: string;
  TestingEnvironmentVariables?: Record<string, string>;
}

/** Format 2 (a test plan) lists targets per configuration; format 1 has one key per target. */
function xctestrunTargets(plist: Record<string, unknown>): XctestrunTarget[] {
  const configurations = plist.TestConfigurations as { TestTargets?: XctestrunTarget[] }[] | undefined;
  if (configurations) return configurations.flatMap((c) => c.TestTargets ?? []);
  return Object.entries(plist)
    .filter(([key, value]) => !key.startsWith("__") && typeof value === "object" && value !== null && "TestBundlePath" in value)
    .map(([, value]) => value as XctestrunTarget);
}

function quote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
