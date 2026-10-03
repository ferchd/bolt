import { Logger } from "./logger.ts";

const logger = Logger.create({ name: "bolt" });

export default logger;

export { Logger } from "./logger.ts";

export type {
  LogContext,
  LogFormat,
  LogLevel,
  LoggerOptions,
  LogWriter,
} from "./logger.ts";
