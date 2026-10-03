import { BoltApplication } from "@bolt/kernel";
import router from "@bolt/router";

router.get("/", () => ({ hello: "world" }));

router
  .group(() => {
    router.post("signup", () => ({ created: true }));
    router.post("login", () => ({ authenticated: true }));
  })
  .prefix("/api/v1/auth")
  .as("auth");

const application = BoltApplication.create({ router });

await application.start();

console.log(`Bolt is running at ${application.url}`);
