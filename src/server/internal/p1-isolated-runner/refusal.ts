import type { RunnerVerdict } from "@/server/internal/p1-isolated-runner/contract";

export class RunnerRefusal extends Error {
  readonly verdict: Extract<RunnerVerdict, "STOP" | "BLOCKED">;
  readonly code: string;

  constructor(verdict: Extract<RunnerVerdict, "STOP" | "BLOCKED">, code: string, message: string) {
    super(message);
    this.name = "RunnerRefusal";
    this.verdict = verdict;
    this.code = code;
  }
}

export function refusal(
  verdict: Extract<RunnerVerdict, "STOP" | "BLOCKED">,
  code: string,
  message: string,
): RunnerRefusal {
  return new RunnerRefusal(verdict, code, message);
}
