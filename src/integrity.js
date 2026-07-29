import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, normalized(value[key])]),
  );
};

export const canonicalJson = (value) => JSON.stringify(normalized(value));

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export const summarizeFile = async (path, displayPath) => {
  const digest = createHash("sha256");
  let bytes = 0;

  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    digest.update(chunk);
  }

  return {
    path: displayPath,
    bytes,
    sha256: digest.digest("hex"),
  };
};

export const writeImmutable = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      const conflict = new Error(
        `Immutable path already contains different data: ${path}`,
      );
      conflict.code = "E_IMMUTABLE_CONFLICT";
      throw conflict;
    }
    return false;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};
