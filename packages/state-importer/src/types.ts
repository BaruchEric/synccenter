export type ResourceKind = "folder" | "host";

export interface ImportResource {
  kind: ResourceKind;
  name: string;
}

export type ImportStatus = "identical" | "would-change" | "written";

export interface ImportResult {
  resource: ImportResource;
  path: string;
  status: ImportStatus;
  diff?: string;
}

export interface HostInfo {
  name: string;
  apiUrl: string;
  apiKey: string;
}

export interface ImportOpts {
  configDir: string;
  hosts: HostInfo[];
  write?: boolean;
  fetch?: typeof fetch;
}
