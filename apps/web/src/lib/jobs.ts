import type { JobKind, JobState } from "@/lib/api";

/** What a job's kind is called, the same on the list and on the job page. */
export const JOB_KIND_LABEL: Record<JobKind, string> = {
  sync: "full sync",
  bisync: "bisync",
  window: "sync window",
};

/** One colour per job state, shared by the list, the job page and its running lamp. */
export const JOB_STATE_TONE: Record<JobState, string> = {
  running: "text-signal",
  done: "text-ok",
  partial: "text-signal",
  failed: "text-fail",
  stopped: "text-dry",
};
