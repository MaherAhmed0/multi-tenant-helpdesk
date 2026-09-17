export function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a valid TCP port.`);
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }

  return port;
}

export function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;

  throw new Error(`${name} must be either "true" or "false"`);
}

export function parseRedisUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["redis:", "rediss:"].includes(url.protocol) ||
      !url.hostname || url.search || url.hash ||
      (url.pathname !== "" && url.pathname !== "/" && !/^\/\d+$/.test(url.pathname))
    ) throw new Error();
    if (url.port) parsePort(url.port, "REDIS_URL");
    if (url.pathname.length > 1 && !Number.isSafeInteger(Number(url.pathname.slice(1)))) {
      throw new Error();
    }
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return value;
  } catch {
    // Never include the supplied URL: it may contain credentials.
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// connection URL");
  }
}

export function parseTotpEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");

  // Buffer.from is permissive; round-trip equality requires canonical Base64.
  if (key.toString("base64") !== value) {
    throw new Error("TOTP_ENCRYPTION_KEY must be valid standard Base64");
  }

  if (key.length !== 32) {
    throw new Error("TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  return key;
}
