/**
 * A Syncthing daemon whose folder state the test scripts directly. Shared by
 * the sync-window engine tests and the Sync-now chain tests, which both
 * need a daemon that can be told "you are idle now" or "you lost the peer".
 */
export class FakeDaemon {
  calls: string[] = [];
  paused = true;
  state = "idle";
  needBytes = 0;
  needFiles = 0;
  inSyncBytes = 1000;
  globalBytes = 1000;
  peerCompletion = 100;
  peerConnected = true;
  failStatus: Error | null = null;
  failResume: Error | null = null;

  async getStatus() {
    this.calls.push("getStatus");
    return { myID: "SELF-DEVICE", uptime: 1, startTime: "", alloc: 0, goroutines: 0 };
  }
  async getFolder(id: string) {
    this.calls.push(`getFolder:${id}`);
    return {
      id,
      label: id,
      path: "/share/Sync/" + id,
      type: "sendreceive" as const,
      devices: [{ deviceID: "SELF-DEVICE" }, { deviceID: "PEER-DEVICE" }],
      paused: this.paused,
    };
  }
  async getFolderStatus(id: string) {
    this.calls.push(`getFolderStatus:${id}`);
    if (this.failStatus) throw this.failStatus;
    return {
      state: this.state,
      globalBytes: this.globalBytes,
      globalFiles: 10,
      localBytes: this.inSyncBytes,
      localFiles: 10,
      inSyncBytes: this.inSyncBytes,
      needBytes: this.needBytes,
      needFiles: this.needFiles,
      errors: 0,
      pullErrors: 0,
      sequence: 1,
      stateChanged: "2026-08-15T00:00:00Z",
    };
  }
  async getConnections() {
    this.calls.push("getConnections");
    return { connections: { "PEER-DEVICE": { connected: this.peerConnected, paused: false } } };
  }
  async getCompletion(folder: string, device: string) {
    this.calls.push(`getCompletion:${folder}:${device}`);
    return { completion: this.peerCompletion, globalBytes: 0, needBytes: 0, needItems: 0, needDeletes: 0 };
  }
  async pauseFolder(id: string) {
    this.calls.push(`pauseFolder:${id}`);
    this.paused = true;
  }
  async resumeFolder(id: string) {
    this.calls.push(`resumeFolder:${id}`);
    if (this.failResume) throw this.failResume;
    this.paused = false;
  }
  async scan(id: string) {
    this.calls.push(`scan:${id}`);
  }
}
