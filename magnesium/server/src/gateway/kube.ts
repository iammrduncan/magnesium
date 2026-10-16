import { SpokeError } from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * The Kubernetes API, as the gateway's namespace identity (goal 25). Only the
 * namespaced calls a gateway makes: server-side apply, get, list and delete.
 * The cluster's envelope decides what is allowed; a refusal comes back as a
 * `SpokeError` with the cluster's own sentence.
 */

export interface KubeObjectPath {
  /** `/api/v1` or `/apis/apps/v1`. */
  readonly group: string;
  /** The plural resource, such as `deployments`. */
  readonly resource: string;
  readonly name?: string;
}

export class KubeApi extends Context.Service<
  KubeApi,
  {
    readonly namespace: string;
    /** Creates or updates `body` with server-side apply, owned by Magnesium. */
    readonly apply: (path: KubeObjectPath, body: unknown) => Effect.Effect<unknown, SpokeError>;
    /** An object, or none when it doesn't exist. */
    readonly get: (path: KubeObjectPath) => Effect.Effect<Option.Option<unknown>, SpokeError>;
    readonly list: (
      path: KubeObjectPath,
      labelSelector: string,
    ) => Effect.Effect<ReadonlyArray<unknown>, SpokeError>;
    /** Deletes an object; one that is already gone is fine. */
    readonly remove: (path: KubeObjectPath) => Effect.Effect<void, SpokeError>;
  }
>()("@magnesium/server/gateway/kube/KubeApi") {}

/** Where a pod finds its own identity, by Kubernetes' convention. */
export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

interface KubeAccess {
  readonly server: string;
  readonly namespace: string;
  /** Read for each call: the kubelet rotates the token. */
  readonly token: Effect.Effect<string, SpokeError>;
}

const objectUrl = (access: KubeAccess, path: KubeObjectPath) =>
  `${access.server}${path.group}/namespaces/${encodeURIComponent(access.namespace)}/${path.resource}${
    path.name === undefined ? "" : `/${encodeURIComponent(path.name)}`
  }`;

/** The cluster's sentence from an error body, such as an admission refusal. */
const refusal = (status: number, body: unknown) => {
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : `The cluster answered ${status}.`;
  return new SpokeError({ detail: message });
};

export const make = (access: KubeAccess) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const token = yield* access.token;
        const response = yield* client
          .execute(HttpClientRequest.bearerToken(request, token))
          .pipe(
            Effect.mapError(
              () => new SpokeError({ detail: "The gateway could not reach the cluster's API." }),
            ),
          );
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
        return { status: response.status, body };
      }).pipe(Effect.scoped);

    return KubeApi.of({
      namespace: access.namespace,
      apply: (path, body) =>
        send(
          HttpClientRequest.patch(
            `${objectUrl(access, path)}?fieldManager=magnesium&force=true`,
          ).pipe(HttpClientRequest.bodyText(JSON.stringify(body), "application/apply-patch+yaml")),
        ).pipe(
          Effect.flatMap(({ status, body: answer }) =>
            status >= 200 && status < 300
              ? Effect.succeed(answer)
              : Effect.fail(refusal(status, answer)),
          ),
        ),
      get: (path) =>
        send(HttpClientRequest.get(objectUrl(access, path))).pipe(
          Effect.flatMap(({ status, body }) =>
            status === 404
              ? Effect.succeedNone
              : status >= 200 && status < 300
                ? Effect.succeedSome(body)
                : Effect.fail(refusal(status, body)),
          ),
        ),
      list: (path, labelSelector) =>
        send(
          HttpClientRequest.get(
            `${objectUrl(access, path)}?labelSelector=${encodeURIComponent(labelSelector)}`,
          ),
        ).pipe(
          Effect.flatMap(({ status, body }) => {
            if (status < 200 || status >= 300) return Effect.fail(refusal(status, body));
            const items =
              typeof body === "object" &&
              body !== null &&
              "items" in body &&
              Array.isArray(body.items)
                ? (body.items as ReadonlyArray<unknown>)
                : [];
            return Effect.succeed(items);
          }),
        ),
      remove: (path) =>
        send(HttpClientRequest.delete(objectUrl(access, path))).pipe(
          Effect.flatMap(({ status, body }) =>
            status === 404 || (status >= 200 && status < 300)
              ? Effect.void
              : Effect.fail(refusal(status, body)),
          ),
        ),
    });
  });

/**
 * The API from inside a pod: the service account's token and namespace on
 * disk, and the API server Kubernetes names in every pod's environment. Its
 * CA reaches Node through `NODE_EXTRA_CA_CERTS`, which the image's entrypoint
 * sets when the account is mounted.
 */
export const inClusterLayer = Layer.effect(
  KubeApi,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) =>
      fs.readFileString(`${SERVICE_ACCOUNT_DIR}/${file}`).pipe(
        Effect.map((text) => text.trim()),
        Effect.mapError(
          () =>
            new SpokeError({
              detail: `The gateway has no service account mounted (${SERVICE_ACCOUNT_DIR}/${file}).`,
            }),
        ),
      );
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    const namespace = yield* read("namespace").pipe(Effect.orElseSucceed(() => ""));
    return yield* make({
      server:
        host === undefined
          ? "https://kubernetes.default.svc"
          : `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
      namespace,
      token: read("token"),
    });
  }),
);
