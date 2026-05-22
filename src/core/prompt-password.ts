// Read a password from the terminal without echoing it. Falls back to
// a plain readline when stdin isn't a TTY (e.g. tests piping input).
// Originally lived in cli/commands/auth.ts; moved here so both the
// `auth password` command and `session attach` can reuse it.

export async function promptPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    return readLineFromStdin();
  }
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw === true;
    let buffer = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      if (!wasRaw) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0a || byte === 0x0d) {
          process.stdout.write("\n");
          cleanup();
          resolve(buffer);
          return;
        }
        if (byte === 0x03) {
          cleanup();
          reject(new Error("password entry cancelled"));
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += String.fromCharCode(byte);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

function readLineFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("error", onError);
        resolve(buffer.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onError = (err: Error): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      reject(err);
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}
