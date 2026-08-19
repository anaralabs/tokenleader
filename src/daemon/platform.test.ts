import { describe, expect, test } from "bun:test";
import { binaryAssetSuffix, daemonArch, platformKey, PUBLISHED_PLATFORM_KEYS } from "./platform.ts";

describe("daemonArch", () => {
  test("collapses to the two arches we build for", () => {
    expect(daemonArch("arm64")).toBe("arm64");
    expect(daemonArch("x64")).toBe("x64");
    // Historical pickArch() behaviour: anything exotic is treated as x64.
    expect(daemonArch("ia32")).toBe("x64");
    expect(daemonArch("riscv64")).toBe("x64");
  });
});

describe("platformKey", () => {
  test("is ${os}-${arch}", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformKey("darwin", "x64")).toBe("darwin-x64");
    expect(platformKey("linux", "arm64")).toBe("linux-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
  });

  test("every published platform is expressible", () => {
    const built = new Set([
      platformKey("darwin", "arm64"),
      platformKey("darwin", "x64"),
      platformKey("linux", "x64"),
      platformKey("linux", "arm64"),
    ]);
    for (const key of PUBLISHED_PLATFORM_KEYS) expect(built.has(key)).toBe(true);
  });
});

describe("binaryAssetSuffix", () => {
  test("darwin keeps the FROZEN bare-arch /bin names", () => {
    // 23 fielded daemons build /bin/anara-leaderboard-<suffix> straight from
    // process.arch. Renaming these would strand every one of them.
    expect(binaryAssetSuffix("darwin", "arm64")).toBe("arm64");
    expect(binaryAssetSuffix("darwin", "x64")).toBe("x64");
  });

  test("linux is platform-keyed, so it can never collide with a darwin asset", () => {
    expect(binaryAssetSuffix("linux", "x64")).toBe("linux-x64");
    expect(binaryAssetSuffix("linux", "arm64")).toBe("linux-arm64");
    expect(binaryAssetSuffix("linux", "x64")).not.toBe(binaryAssetSuffix("darwin", "x64"));
  });
});
