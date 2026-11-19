type ApprovalId = string | number;
type ApprovalType = "file-change" | "command-execution" | "permission" | "unknown";
type ApprovalStatus = "pending" | "denied" | "expired" | "approved";

interface ApprovalRequest {
  id: ApprovalId;
  method: string;
  type: ApprovalType;
  target?: string;
  command?: string;
  reason?: string;
  workspace: string;
  connectionId: string;
  submissionId: string;
  timestamp: string;
  expiresAt: string;
  status: ApprovalStatus;
}

interface ApprovalDecision {
  decision: "accept" | "decline";
}

interface PendingApproval {
  record: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const maxDetailLength = 4_096;

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxDetailLength ? `${value.slice(0, maxDetailLength)}…` : value;
}

function approvalType(method: string): ApprovalType {
  if (method.includes("fileChange")) return "file-change";
  if (method.includes("commandExecution")) return "command-execution";
  if (method.includes("permissions")) return "permission";
  return "unknown";
}

function approvalKey(id: ApprovalId): string {
  return `${typeof id}:${String(id)}`;
}

class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly records = new Map<string, ApprovalRequest>();

  constructor(
    private readonly workspace: string,
    private readonly connectionId = "unknown",
    private readonly timeoutMs = 30_000,
    private readonly autoDecline = true,
    private readonly simulation = false,
    private readonly allowApproval = false,
  ) {}

  private submissionId = "unknown";

  setSubmissionId(submissionId: string): void {
    this.submissionId = submissionId;
  }

  request(id: ApprovalId, method: string, params: any = {}, workspaceOverride?: string): Promise<ApprovalDecision> {
    const key = approvalKey(id);
    const record: ApprovalRequest = {
      id,
      method,
      type: approvalType(method),
      workspace: workspaceOverride || this.workspace,
      connectionId: this.connectionId,
      submissionId: this.submissionId,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      status: "pending",
    };
    const target = bounded(params?.grantRoot || params?.cwd || params?.path);
    const command = bounded(Array.isArray(params?.command) ? params.command.join(" ") : params?.command);
    const reason = bounded(params?.reason);
    if (target !== undefined) record.target = target;
    if (command !== undefined) record.command = command;
    if (reason !== undefined) record.reason = reason;
    this.records.set(key, record);

    if (this.autoDecline) return Promise.resolve(this.deny(id, "Automatic approval is disabled."));

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.expire(id);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(key, { record, resolve, timer });
    });
  }

  approve(id: ApprovalId): ApprovalDecision {
    if (this.simulation || this.allowApproval) {
      const key = approvalKey(id);
      const entry = this.pending.get(key);
      const record = this.records.get(key);
      if (record) record.status = "approved";
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        entry.resolve({ decision: "accept" });
      }
      return { decision: "accept" };
    }
    return this.deny(id, "Approval execution is disabled until the VS Code approval UI exists.");
  }

  deny(id: ApprovalId, _reason = "Denied by user."): { decision: "decline" } {
    const key = approvalKey(id);
    const entry = this.pending.get(key);
    const record = this.records.get(key);
    if (record) record.status = "denied";
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      entry.resolve({ decision: "decline" });
    }
    return { decision: "decline" };
  }

  private expire(id: ApprovalId): void {
    const key = approvalKey(id);
    const entry = this.pending.get(key);
    const record = this.records.get(key);
    if (record) record.status = "expired";
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      entry.resolve({ decision: "decline" });
    }
  }

  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.record }));
  }

  get(id: ApprovalId): ApprovalRequest | undefined {
    const record = this.records.get(approvalKey(id));
    return record ? { ...record } : undefined;
  }

  allRequests(): ApprovalRequest[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  isSimulation(): boolean {
    return this.simulation;
  }
}

export = { ApprovalBroker };
