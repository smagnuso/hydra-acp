// Extensions are conventionally named hydra-acp-<foo>; a plain hydra-<foo> works the same way.
const PREFIXES = ["hydra-acp-", "hydra-"] as const;

// The short form a registered extension answers to, or undefined when its name has no such prefix.
export function elidedExtensionName(name: string): string | undefined {
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return undefined;
}

// Registered names a short form could stand for, in lookup order.
export function prefixedExtensionNames(short: string): string[] {
  return PREFIXES.map((prefix) => `${prefix}${short}`);
}
