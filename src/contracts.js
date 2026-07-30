const controlCharacters = /[\u0000-\u001f\u007f]/u;

export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isPortableRelativePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !controlCharacters.test(value) &&
  !value.includes(":") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

export const isValidTask = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  [...value].length <= 200 &&
  !controlCharacters.test(value);

export const compareCodeUnits = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
