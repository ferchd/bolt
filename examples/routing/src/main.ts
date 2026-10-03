import router from "@bolt/router";

router.get("/", () => ({ hello: "world" }));

router
  .group(() => {
    router.post("signup", () => ({ created: true }));
    router.post("login", () => ({ authenticated: true }));
  })
  .prefix("/api/v1/auth")
  .as("auth");

console.log(router.compile());
