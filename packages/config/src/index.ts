import { Environment } from "./environment.ts";

const env = Environment.create();

export default env;

export { Environment } from "./environment.ts";
export { EnvironmentError } from "./environment-error.ts";

export type { EnvironmentSource } from "./environment.ts";
