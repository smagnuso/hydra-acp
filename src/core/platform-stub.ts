import { afterAll, beforeAll } from "vitest";
// Test helper: run fn with process.platform stubbed, restoring it afterwards.
export async function onPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// Test helper: pin process.platform for a whole file. For suites that assert
// POSIX-style behaviour and would otherwise see the host's, e.g. colour
// depth, which assumes a modern console on Windows whatever TERM says.
export function pinPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeAll(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", original);
  });
}
