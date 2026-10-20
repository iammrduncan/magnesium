<!-- magnesium: machines in Kubernetes, in Magnesium's own pods or inside your workloads' pods (goal 25, D59, D60) -->

# Machines in Kubernetes

A machine server can run in a Kubernetes cluster two ways:

- **In its own pod**, when the machine's work is Magnesium itself. The hub runs, stops and upgrades it for you.
- **Inside a workload's pod**, beside the workload's own process, so agents work with that workload's files, tools, GPUs and models. Your deploy runs it; the workload's image doesn't change.

Both reach the hub through a **gateway**: one Magnesium server in a namespace that the hub talks through. Your cluster's operator sets it up once; see [the Kubernetes guide](../../magnesium/deploy/kubernetes/README.md#reaching-it-the-gateway). The Magnesium image both use is built from this repo; see [The image](../../magnesium/deploy/kubernetes/README.md#the-image).

## Magnesium in its own pod

Every machine is in one list, **Settings → Connections → Environments**, which says what each is: bare metal, a VM, a Magnesium pod, attached in a workload, or the gateway.

Choose **Add environment → A Magnesium pod**: its gateway, a name, the node it runs on, its home folder and volume size, and OpenCode's gateway and models if it uses OpenCode. The hub pairs with it by itself once it is up.

A Magnesium pod's menu in that list has **Stop its pod** and **Start its pod**, **Edit…**, **Change build** (blank runs its gateway's own build), and **Remove its pod**, which keeps its home unless you untick that. **Edit…**, also **Edit pod** in its **Fleet** panel, changes its node, OpenCode's gateway and models, and the model keys it gets; the pod restarts to take the change, keeping its home and threads.

In **Fleet**, a Magnesium pod's **Update** changes its image to the hub's build through its gateway, and **Roll back** puts back the build it ran before; one that isn't up on its new build within ten minutes goes back on its own. It backs itself up every day into its home, and **Restore** from Fleet restarts the pod on a backup. Replacing a key in **Settings → Model keys** reaches every pod that gets it, and each restarts to take the new value.

**Moving a machine in** keeps its threads and the hub's access: add it with **Start it now** unticked and the same name and home folder it had, copy its home into the volume, then **Start** it. The full steps are in [Moving a machine from bare metal](../../magnesium/deploy/kubernetes/README.md#moving-a-machine-from-bare-metal).

## Magnesium inside your workload's pods

Four additions to the workload's manifest put Magnesium in every pod it starts, whether the workload is new or already running:

1. **An init container** from the Magnesium image that copies its install into a shared volume with `magnesium-bundle-copy`, which works as any user.
2. **The workload's command, wrapped:** `/opt/magnesium-portable/bin/magnesium-attach -- <the command it ran before>`. Write out the whole command: a pod's `command` replaces the image's own entrypoint. The workload stays the main process; Magnesium runs beside it and starts again if it stops.
3. **A home volume** for Magnesium's state and the agents' own sign-ins, and the environment below.
4. **A route** the gateway follows: a Service in the workload's namespace, and a labelled `ExternalName` beside the gateway.

For an existing workload, apply the edited manifest: its pods restart once, with Magnesium in them. For a new one, start from it.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: notebook, namespace: research }
spec:
  replicas: 1
  strategy: { type: Recreate } # one pod at a time on Magnesium's home
  selector: { matchLabels: { app: notebook } }
  template:
    metadata: { labels: { app: notebook } }
    spec:
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
      initContainers:
        - name: magnesium-bundle
          image: magnesium:<build>
          command: ["/opt/magnesium-portable/bin/magnesium-bundle-copy", "/bundle"]
          volumeMounts: [{ name: magnesium-bundle, mountPath: /bundle }]
      containers:
        - name: notebook
          image: example/notebook:1.0 # unchanged
          command:
            - /opt/magnesium-portable/bin/magnesium-attach
            - --
            - jupyter
            - lab
            - --ip=0.0.0.0
          env:
            - { name: MAGNESIUM_HOME, value: /home/magnesium }
            - { name: MAGNESIUM_MACHINE, value: notebook }
            - { name: MAGNESIUM_WORKLOAD, value: notebook }
            - name: MAGNESIUM_NODE
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
            - name: MAGNESIUM_HUB_PAIRING_CODE # a new machine only
              valueFrom:
                secretKeyRef:
                  {
                    name: notebook-magnesium-pairing,
                    key: MAGNESIUM_HUB_PAIRING_CODE,
                    optional: true,
                  }
          ports: [{ name: magnesium, containerPort: 3773 }]
          volumeMounts:
            - { name: magnesium-bundle, mountPath: /opt/magnesium-portable, readOnly: true }
            - { name: magnesium-home, mountPath: /home/magnesium }
      volumes:
        - { name: magnesium-bundle, emptyDir: {} }
        - { name: magnesium-home, persistentVolumeClaim: { claimName: notebook-magnesium-home } }
---
# The workload's side of the route.
apiVersion: v1
kind: Service
metadata: { name: magnesium-notebook, namespace: research }
spec:
  selector: { app: notebook }
  ports: [{ name: magnesium, port: 3773, targetPort: magnesium }]
---
# The gateway's side: labelled, so the hub finds the machine by itself.
apiVersion: v1
kind: Service
metadata:
  name: magnesium-notebook
  namespace: magnesium # the gateway's namespace
  labels: { magnesium.dev/attached: notebook, magnesium.dev/workload: notebook }
spec:
  type: ExternalName
  externalName: magnesium-notebook.research.svc.cluster.local
```

Add the home's PersistentVolumeClaim, and network policies that let the gateway's pods reach the workload's pods on port 3773 and let Magnesium reach the internet for its models. In a pod on the host's network, set `T3CODE_PORT` to a port the host isn't using, and use it in the Service too.

**What agents get:** the container's files, tools and devices, as the container's user. Agents in a workload with GPUs can use them, and agents in a privileged pod are as privileged as it is: attach to unprivileged workloads unless you mean otherwise. The fence keeps agents out of Magnesium's own state, as in any pod. The install brings git, Python and its own Node for images that lack them, and needs a glibc-based image (Debian, Ubuntu or similar).

### Pairing

**A new machine pairs by itself.** Make a random code of 16 or more characters (`openssl rand -hex 16`), and put it in two Secrets: one in the workload's namespace for the pod (`notebook-magnesium-pairing` above), and one beside the gateway for the hub, named `magnesium-<machine>-pairing` with the key `MAGNESIUM_HUB_PAIRING_CODE`. Within a minute of the pod starting, the hub finds the machine through its gateway and pairs. The gateway then labels the route `magnesium.dev/paired: "true"` and deletes its copy of the code; write that copy only while the label is absent, so a redeploy never brings back a spent code.

**A machine moving in** from bare metal or from its own pod needs no code: give it the same `MAGNESIUM_MACHINE` name, copy its home into the new volume, and mount that at the same path it had, since projects are kept by path. The hub keeps its access and its threads.

**Without the labels,** attach it by hand with **Add environment → Attach a workload's machine**, giving its gateway, name and code.

The machine shows in **Fleet** and in **Environments** as "in notebook on <node>". It backs itself up daily into its home, and Fleet can restore it. Its build is the Magnesium image the workload's manifest names, so Fleet shows when it's behind the hub's but leaves updating it to that manifest.

### Taking it out

Remove the init container, the wrapper, the environment and the route from the manifest, and apply it: the workload runs on as before. Its row in **Environments** then says its route has gone; choose **Detach** in its menu to let it go from the hub. While the workload still runs Magnesium, Detach refuses, since the hub would find it again.

**Moving a machine back** to where it ran before, such as its bare metal: take Magnesium out of the workload, start the old server again, and Detach with **Keep the hub's access** ticked. The hub reaches it where it was, with the same access, and its threads up to the move.
