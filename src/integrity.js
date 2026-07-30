import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compareCodeUnits } from "./contracts.js";

const serializeCanonical = (value) => {
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new TypeError("Canonical JSON does not accept sparse arrays.");
      }
      items.push(serializeCanonical(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("Canonical JSON accepts only finite JSON data.");
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("Canonical JSON accepts only JSON object members.");
  }
  return `{${keys
    .sort(compareCodeUnits)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical(value[key])}`,
    )
    .join(",")}}`;
};

export const canonicalJson = (value) => serializeCanonical(value);

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export const readRegularFile = async (path) => {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);

  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      const error = new Error(`Expected a regular file: ${path}`);
      error.code = "E_PATH_TYPE";
      throw error;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const summarizeFile = async (path, displayPath) => {
  const digest = createHash("sha256");
  let bytes = 0;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);

  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      const error = new Error(`Expected a regular file: ${path}`);
      error.code = "E_PATH_TYPE";
      throw error;
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      digest.update(chunk);
    }
  } finally {
    await handle.close();
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
  let handle;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const status = await lstat(path, { bigint: true }).catch(() => null);
      if (!status?.isFile() || status.isSymbolicLink()) {
        const unsafe = new Error(
          `Immutable path must already be a regular non-symbolic file: ${path}`,
        );
        unsafe.code = "E_IMMUTABLE_TARGET";
        throw unsafe;
      }

      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      let existingHandle;
      try {
        existingHandle = await open(path, flags);
        const openedStatus = await existingHandle.stat({ bigint: true });
        const afterOpenStatus = await lstat(path, { bigint: true });
        const sameFile =
          status.dev === openedStatus.dev &&
          status.ino === openedStatus.ino &&
          status.dev === afterOpenStatus.dev &&
          status.ino === afterOpenStatus.ino;
        if (
          !openedStatus.isFile() ||
          afterOpenStatus.isSymbolicLink() ||
          !afterOpenStatus.isFile() ||
          !sameFile
        ) {
          const unsafe = new Error(
            `Immutable path must already be a regular file: ${path}`,
          );
          unsafe.code = "E_IMMUTABLE_TARGET";
          throw unsafe;
        }
        const existing = await existingHandle.readFile();
        const expected = Buffer.isBuffer(content)
          ? content
          : Buffer.from(content, "utf8");
        if (!existing.equals(expected)) {
          const conflict = new Error(
            `Immutable path already contains different data: ${path}`,
          );
          conflict.code = "E_IMMUTABLE_CONFLICT";
          throw conflict;
        }
      } catch (existingError) {
        if (
          existingError.code === "ELOOP" ||
          existingError.code === "EISDIR"
        ) {
          const unsafe = new Error(
            `Immutable path must already be a regular non-symbolic file: ${path}`,
          );
          unsafe.code = "E_IMMUTABLE_TARGET";
          throw unsafe;
        }
        throw existingError;
      } finally {
        await existingHandle?.close();
      }
      return false;
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};
