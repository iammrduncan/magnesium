# Magnesium as a product: what it needs from a lab

**Status: decided (D57), refined by D59.** Magnesium is a product. It must install and run in any lab, set up however its owner likes. So there is one line: Magnesium owns everything about agents and its own services, and a lab gives it an envelope to run in.

## What Magnesium needs from any lab

Four things, each filled once by config. Nothing else about a lab is built into Magnesium.

| Interface                         | What a lab provides                                               | Options Magnesium supports                                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where its machine servers run** | Places to run spokes                                              | Only the hub (a single box); hosts reached over SSH, bare metal or VMs, deployed with Magnesium's Ansible roles; attached inside the workload pods a cluster already runs (D59); or a Kubernetes namespace with a deploy identity, where Magnesium runs a gateway that deploys its spokes |
| **How the hub reaches them**      | A path from the hub to each spoke, for the hub alone (D38)        | A URL per spoke (a LAN, a tailnet or a relay), or one entry point to the namespace's gateway, which routes to each spoke                                                                                                                                                                  |
| **Model access**                  | One or a few provider keys, or OpenAI-compatible gateways         | Entered once in Magnesium (goal 30). Magnesium decides which profile uses which model, sets limits and records usage                                                                                                                                                                      |
| **Storage**                       | Disks for each server's state, the hub's Magnesium Brain included | A home folder on a host, or volumes in the namespace for spokes. The Brain lives with the hub, on the hub's system (D58)                                                                                                                                                                  |

## Who owns what

**Magnesium owns everything inside the envelope:**

- **Its spokes:** how many, where among the allowed places, their build, settings, volumes and lifecycle. In Kubernetes, it deploys and changes them itself.
- **Agents:** each profile's harness, tools, models, Brain access and credentials. They are held in the hub's secret store, handed to a session when it starts, and recorded in Magnesium.
- **The Magnesium Brain** (D56, D58): its own knowledge base, part of the hub application on the hub's own system, run, stored and access-controlled by Magnesium (goal 29).
- **Tools and apps:** MCP tools, apps and machine parts (goals 16 and 28) run or are proxied through Magnesium, so a new tool never needs a lab change.

**A lab owns the envelope:**

- the machines, a cluster if any, which nodes Magnesium may use, quotas, the security level of its pods, and storage classes;
- the network: what Magnesium may reach and how the hub reaches it;
- building Magnesium's images, until Magnesium publishes its own;
- host safety, volume backups, monitoring, and the lab's own identities and secret store. That store seeds Magnesium's few top-level keys once; it never holds per-agent credentials.

**The rules between them:**

- Magnesium can't widen the envelope: no nodes, quotas, network rules, security levels or cluster-wide objects of its own choosing.
- A lab never wires anything per agent, per tool or per session. When a lab is asked to add a key or a grant for one agent, that work belongs in Magnesium.
- Magnesium's code and defaults name no lab: no hosts, networks, vaults or services.

## In Kubernetes

Magnesium's specs fit an envelope like this one, which a lab enforces with admission rather than trust:

- **Pod security `restricted`:** non-root, no privilege escalation, every capability dropped, `RuntimeDefault` seccomp. Magnesium's fence works within it (Landlock).
- **Placement:** pods only on nodes from an allowed list the lab keeps; no GPU resources, host paths, host network or host ports.
- **Services:** ClusterIP only.
- **Images:** from an allowed registry prefix, pinned by digest.
- **A quota and default limits** for CPU, memory, storage and object counts; no node ports or load balancers.
- **Network:** egress to DNS, the public internet and other pods in the namespace; ingress only from inside the namespace, plus the one published entry point to Magnesium's gateway.
- **A deploy identity** limited to the namespace: Deployments, StatefulSets, Services, ConfigMaps, Secrets, PersistentVolumeClaims and pods, with exec, logs and events to read. No roles, network policies, quotas or anything cluster-wide.

The lab bootstraps the namespace and Magnesium's gateway once, at a pinned build. Magnesium manages everything after that, its gateway's upgrades included.

**The Magnesium Brain** is part of the hub application, on the hub's own system (D58), not in a cluster. Its recovery is part of the hub's.
