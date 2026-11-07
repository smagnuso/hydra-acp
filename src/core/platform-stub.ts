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
