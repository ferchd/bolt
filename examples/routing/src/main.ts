import { resolve } from "node:path";

import env from "@bolt/config";
import { abort, BoltApplication } from "@bolt/kernel";
import router from "@bolt/router";
import v from "@bolt/validation";

const credentialsSchema = v.object({
  email: v.string().email(),
});

router.static("/assets", resolve(import.meta.dir, "../public"));

router.get("/", (context) => {
  context.cookies.set("visited", "true");

  return {
    application: env.string("APP_NAME", "Bolt"),
    hello: context.query.get("name") ?? "world",
  };
});

router
  .group(() => {
    router.post("signup", async (context) => ({
      account: await context.json<unknown>(),
      created: true,
    }));
    router.post("login", async (context) => {
      const credentials = await context.validate.body(credentialsSchema);

      if (credentials.email.endsWith("@blocked.test")) {
        abort(422, "Email is not allowed", { code: "INVALID_CREDENTIALS" });
      }

      return { authenticated: true };
    });
  })
  .prefix("/api/v1/auth")
  .as("auth");

const application = BoltApplication.create({ router });

await application.start();
