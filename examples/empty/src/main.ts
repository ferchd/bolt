import { BoltApplication } from "@bolt/kernel";

const application = BoltApplication.create();

await application.start();

console.log(`Bolt is running at ${application.url}`);
