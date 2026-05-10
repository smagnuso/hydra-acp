declare module "pino-roll" {
  import type { SonicBoom } from "sonic-boom";

  export interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: "daily" | "hourly" | number;
    extension?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    symlink?: boolean;
    mkdir?: boolean;
    dateFormat?: string;
    sync?: boolean;
  }

  const createPinoRoll: (options: PinoRollOptions) => Promise<SonicBoom>;
  export default createPinoRoll;
}
