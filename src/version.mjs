export function parseVersion(value) {
  const match = String(value || "").match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(value, minimum) {
  const current = parseVersion(value);
  const required = parseVersion(minimum);
  if (!current || !required) return null;

  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function supportedNodeVersion(value) {
  const version = parseVersion(value);
  if (!version) return null;

  const [major, minor] = version;
  if (major === 20) return minor >= 19;
  return major > 22 || (major === 22 && minor >= 12);
}
