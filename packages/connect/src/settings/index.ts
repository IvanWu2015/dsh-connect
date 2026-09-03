/**
 * Barrel for the dsh-connect web-settings stack: channel orchestration, the DSH
 * credential-store adapter, the host RPC facade, the persistence service, and
 * the client-side model/RPC helpers. Imported by the merged entry; also the
 * `dsh-connect/settings` subpath export.
 * @module dsh-connect/settings
 */
export * from "./channels.js";
export * from "./credential-store.js";
export * from "./settings-rpc.js";
export * from "./settings-service.js";
export * from "./settings-model.js";
export * from "./rpc-client.js";
