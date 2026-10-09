import { describe, it } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { mock, tmpdir } from "./mocks.js";
import { GRYPE_VERSION } from "../GrypeVersion.js";

let imports = 0;

// installs grype with the download and exec calls mocked out, returning the
// installer URL that was fetched and the environment the installer ran with
async function mockInstall(version) {
  const dir = tmpdir();
  const fakeContent = Buffer.from("fake-grype-binary");
  const fakeHash = crypto
    .createHash("sha256")
    .update(fakeContent)
    .digest("hex");
  const versionNoV = version.replace(/^v/, "");
  const platformMap = { linux: "linux", darwin: "darwin" };
  const archMap = { x64: "amd64", arm64: "arm64" };
  const platform = platformMap[process.platform] ?? "linux";
  const arch = archMap[process.arch] ?? "amd64";
  const archiveFilename = `grype_${versionNoV}_${platform}_${arch}.tar.gz`;
  const checksumsContent = `${fakeHash}  ${archiveFilename}\n`;

  const checksumsFile = path.join(dir, "checksums.txt");
  const archiveFile = path.join(dir, "archive.tar.gz");
  fs.writeFileSync(checksumsFile, checksumsContent);
  fs.writeFileSync(archiveFile, fakeContent);

  let installScriptUrl;
  await mock("@actions/tool-cache", {
    find() {
      return "";
    },
    downloadTool(url) {
      if (url.includes("install.sh")) {
        installScriptUrl = url;
        return "install-script-path";
      }
      if (url.includes("checksums.txt")) {
        return checksumsFile;
      }
      return archiveFile;
    },
    async extractTar(archivePath, extractDir) {
      fs.writeFileSync(path.join(extractDir, "grype"), fakeContent);
      return extractDir;
    },
    cacheFile() {
      return "grype";
    },
  });

  let env;
  await mock("@actions/exec", {
    async exec(cmd, args, options) {
      env = options.env;
      // simulate install.sh writing the binary to installToDir
      // args: [installScriptPath, "-d", "-b", installToDir, version]
      const installToDir = args[3];
      if (installToDir) {
        fs.writeFileSync(path.join(installToDir, "grype"), fakeContent);
      }
      return 0;
    },
  });

  // a fresh copy of the module, so it picks up the mocks above
  const { installGrype } = await import(`../action.js?i=${imports++}`);
  await installGrype(version);

  return { downloadedUrl: installScriptUrl, env };
}

describe("installing grype", () => {
  it("treats only whole release tags as pinnable", async () => {
    const { isReleaseTag } = await import("../action.js");

    for (const version of ["v0.114.0", "v0.1.0", "v1.0.0-rc.1"]) {
      assert.ok(isReleaseTag(version), `expected '${version}' to be a tag`);
    }
    // the version ends up in the URL of a script that gets executed, so
    // anything that could point at another repository has to be rejected
    for (const version of [
      "latest",
      "0.114.0",
      "main",
      "v0.114.0/../../../someone/else/main",
      "v1/../../../someone/else/main",
    ]) {
      assert.ok(
        !isReleaseTag(version),
        `expected '${version}' not to be a tag`,
      );
    }
  });

  it("downloads the installer pinned to the grype release tag", async () => {
    const { downloadedUrl, env } = await mockInstall(GRYPE_VERSION);

    assert.equal(
      downloadedUrl,
      `https://raw.githubusercontent.com/anchore/grype/${GRYPE_VERSION}/install.sh`,
    );
    // otherwise the installer would fetch and run an unpinned copy of itself
    assert.equal(env.DOWNLOAD_TAG_INSTALL_SCRIPT, "false");
  });

  it("falls back to the default branch for a version that is not a tag", async () => {
    const { downloadedUrl, env } = await mockInstall("latest");

    assert.equal(
      downloadedUrl,
      "https://raw.githubusercontent.com/anchore/grype/main/install.sh",
    );
    // the installer resolves "latest" itself and fetches its tagged version
    assert.equal(env.DOWNLOAD_TAG_INSTALL_SCRIPT, "true");
  });
});
