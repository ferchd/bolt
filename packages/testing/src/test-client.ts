import {
  BoltApplication,
  type ApplicationOptions,
} from "@bolt/kernel";

export type QueryPrimitive = bigint | boolean | null | number | string | undefined;

export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export type TestQuery = URLSearchParams | Readonly<Record<string, QueryValue>>;

export interface TestRequestOptions
  extends Omit<RequestInit, "body" | "method"> {
  readonly body?: BodyInit | null;
  readonly json?: unknown;
  readonly method?: string;
  readonly query?: TestQuery;
}

export type TestApplicationOptions = Omit<
  ApplicationOptions,
  "hostname" | "port"
> & {
  readonly hostname?: string;
};

export class TestClient {
  readonly #application: BoltApplication;
  #ownsLifecycle: boolean;
  #startOperation?: Promise<void>;

  private constructor(
    application: BoltApplication,
    ownsLifecycle: boolean,
  ) {
    this.#application = application;
    this.#ownsLifecycle = ownsLifecycle;
  }

  public static create(application: BoltApplication): TestClient;
  public static create(options?: TestApplicationOptions): TestClient;
  public static create(
    applicationOrOptions: BoltApplication | TestApplicationOptions = {},
  ): TestClient {
    if (applicationOrOptions instanceof BoltApplication) {
      return new TestClient(applicationOrOptions, false);
    }

    const application = BoltApplication.create({
      ...applicationOrOptions,
      hostname: applicationOrOptions.hostname ?? "127.0.0.1",
      port: 0,
    });

    return new TestClient(application, false);
  }

  public get application(): BoltApplication {
    return this.#application;
  }

  public async request(
    path: string | URL,
    options: TestRequestOptions = {},
  ): Promise<Response> {
    await this.ensureStarted();

    const url = new URL(path, this.#application.url);
    appendQuery(url, options.query);

    const headers = new Headers(options.headers);
    const hasJson = Object.hasOwn(options, "json");

    if (hasJson && options.body !== undefined && options.body !== null) {
      throw new TypeError("A test request cannot define both body and json");
    }

    let body = options.body;

    if (hasJson) {
      body = JSON.stringify(options.json);

      if (body === undefined) {
        throw new TypeError("The json value must be serializable");
      }

      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }

    const { json: _json, query: _query, ...init } = options;

    return fetch(url, {
      ...init,
      body,
      headers,
    });
  }

  public get(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "GET" });
  }

  public post(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "POST" });
  }

  public head(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "HEAD" });
  }

  public options(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "OPTIONS" });
  }

  public put(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "PUT" });
  }

  public patch(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "PATCH" });
  }

  public delete(
    path: string | URL,
    options: Omit<TestRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "DELETE" });
  }

  public async close(): Promise<void> {
    await this.#startOperation;

    if (!this.#ownsLifecycle) {
      return;
    }

    this.#ownsLifecycle = false;
    await this.#application.stop();
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private ensureStarted(): Promise<void> {
    if (this.#application.isRunning) {
      return Promise.resolve();
    }

    if (this.#startOperation) {
      return this.#startOperation;
    }

    const takesLifecycle = this.#application.state !== "starting";
    const operation = this.startApplication(takesLifecycle);
    this.#startOperation = operation;
    operation.then(
      () => this.clearStartOperation(operation),
      () => this.clearStartOperation(operation),
    );

    return operation;
  }

  private async startApplication(takesLifecycle: boolean): Promise<void> {
    if (takesLifecycle) {
      this.#ownsLifecycle = true;
    }

    try {
      await this.#application.start();
    } catch (error) {
      if (takesLifecycle) {
        this.#ownsLifecycle = false;
      }

      throw error;
    }
  }

  private clearStartOperation(operation: Promise<void>): void {
    if (this.#startOperation === operation) {
      this.#startOperation = undefined;
    }
  }
}

function appendQuery(url: URL, query: TestQuery | undefined): void {
  if (!query) {
    return;
  }

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) {
      url.searchParams.append(key, value);
    }

    return;
  }

  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];

    for (const entry of values) {
      if (entry === undefined) {
        continue;
      }

      url.searchParams.append(key, entry === null ? "" : String(entry));
    }
  }
}
