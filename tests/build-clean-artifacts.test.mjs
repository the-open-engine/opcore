import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("build artifact cleanup", () => {
  it("removes stale descriptor and renamed dist outputs before writing the canonical descriptor", () => {
    const tempRepo = mkdtempSync(join(tmpdir(), "opcore-build-clean-"));
    try {
      seedDescriptorWriterFixture(tempRepo);

      const descriptorDir = join(tempRepo, "packages/opcore/dist/descriptors");
      const staleDescriptorPath = join(descriptorDir, "lattice.managed-tool.json");
      const canonicalDescriptorPath = join(descriptorDir, "opcore.managed-tool.json");
      const staleDistPath = join(tempRepo, "packages/opcore/dist/lattice");
      const distIndexPath = join(tempRepo, "packages/opcore/dist/index.js");
      const advancedIndexPath = join(tempRepo, "packages/opcore/dist/advanced/index.js");
      writeFileSync(staleDescriptorPath, "{\"name\":\"old\"}\n");
      writeFileSync(canonicalDescriptorPath, "{\"name\":\"canonical-before\"}\n");
      mkdirSync(staleDistPath, { recursive: true });
      writeFileSync(join(staleDistPath, "index.js"), "old renamed output\n");

      run(tempRepo, "node", ["scripts/write-cli-descriptor.mjs"]);

      assert.equal(existsSync(staleDescriptorPath), false);
      assert.equal(existsSync(staleDistPath), false);
      assert.equal(existsSync(canonicalDescriptorPath), true);
      assert.equal(readFileSync(distIndexPath, "utf8"), "public bin\n");
      assert.equal(readFileSync(advancedIndexPath, "utf8"), "advanced router\n");
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });
});

function seedDescriptorWriterFixture(tempRepo) {
  mkdirSync(join(tempRepo, "scripts"), { recursive: true });
  mkdirSync(join(tempRepo, "packages/contracts/dist"), { recursive: true });
  mkdirSync(join(tempRepo, "packages/opcore/dist/advanced"), { recursive: true });
  mkdirSync(join(tempRepo, "packages/opcore/dist/descriptors"), { recursive: true });
  cpSync(join(repoRoot, "scripts/write-cli-descriptor.mjs"), join(tempRepo, "scripts/write-cli-descriptor.mjs"));
  writeFileSync(
    join(tempRepo, "packages/contracts/package.json"),
    JSON.stringify({ type: "module" }, null, 2)
  );
  writeFileSync(
    join(tempRepo, "packages/contracts/dist/index.js"),
    "export function validateManagedToolDescriptor(descriptor) { return descriptor; }\n"
  );
  writeFileSync(
    join(tempRepo, "packages/opcore/package.json"),
    `${JSON.stringify({ type: "module", version: "9.8.7" }, null, 2)}\n`
  );
  writeFileSync(join(tempRepo, "packages/opcore/dist/index.js"), "public bin\n");
  writeFileSync(join(tempRepo, "packages/opcore/dist/advanced/index.js"), "advanced router\n");
  writeFileSync(
    join(tempRepo, "packages/opcore/dist/advanced/descriptor.js"),
    [
      "export const descriptorArtifactPath = 'dist/descriptors/opcore.managed-tool.json';",
      "export const opcoreManagedToolDescriptor = {",
      "  aggregateIdentity: { version: '0.0.0' },",
      "  packageIdentity: { version: '0.0.0' }",
      "};",
      ""
    ].join("\n")
  );
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}
