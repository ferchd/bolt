import { BoltApplication } from "@bolt/kernel";

const application = BoltApplication.create();

await application.start();

console.log("Bolt application started");
