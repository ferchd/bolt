import { createTaskApplication } from "./application.ts";

const { application } = createTaskApplication();

await application.start();
